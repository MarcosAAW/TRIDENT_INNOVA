import { formatCurrency, formatDate, formatNumber } from './format.js';
import { confirmDialog } from './dialogs.js';

export function initDashboard(modules) {
  if (!Array.isArray(modules) || !modules.length) {
    throw new Error('Debes registrar al menos un módulo.');
  }

  const navigation = buildModuleNavigation(modules);
  const moduleMap = new Map(modules.map((mod) => [mod.key, mod]));

  const state = {
    moduleKey: modules[0].key,
    items: [],
    meta: null,
    page: 1,
    pageSize: modules[0].pageSize || 20,
    editingId: null,
    formCollapsed: true,
    filtersCollapsed: true,
    secondaryTabsExpanded: isSecondaryModuleKey(modules[0].key)
  };
  let loadRequestSeq = 0;

  const dom = getDomRefs();
  if (dom.year) {
    dom.year.textContent = new Date().getFullYear();
  }
  renderTabs();
  switchModule(state.moduleKey);

  dom.previewButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      renderPreview(btn.dataset.endpoint);
    });
  });

  if (dom.filterForm) {
    dom.filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      state.page = 1;
      loadList({ preserveScroll: true });
    });
  }

  document.addEventListener('dashboard:reload-list', (event) => {
    const preserveScroll = event?.detail?.preserveScroll !== false;
    loadList({ preserveScroll });
  });

  if (dom.listActions) {
    dom.listActions.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-module-action]');
      if (!button) return;
      event.preventDefault();
      if (button.dataset.busy === '1') return;
      const mod = getCurrentModule();
      if (!mod) return;
      const action = button.dataset.moduleAction;
      const handler = mod.moduleActionHandlers && typeof mod.moduleActionHandlers[action] === 'function'
        ? mod.moduleActionHandlers[action]
        : null;
      if (!handler) return;
      button.dataset.busy = '1';
      button.disabled = true;
      try {
        const filters = collectFilters(mod);
        await Promise.resolve(handler({ action, module: mod, filters, event, reload: loadList, showMessage }));
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo ejecutar la acción solicitada.', 'error');
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          delete button.dataset.busy;
        }, 500);
      }
    });
  }

  if (dom.includeDeleted) {
    dom.includeDeleted.addEventListener('change', () => {
      state.page = 1;
      loadList({ preserveScroll: true });
    });
  }

  dom.cancelButton.addEventListener('click', () => {
    setFormModeCreate({ autoExpand: false });
    setFormCollapsed(true);
  });

  dom.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitForm();
  });

  if (dom.tableWrapper) {
    dom.tableWrapper.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const { action, id } = button.dataset;
      if (!id || !action) return;
      const mod = getCurrentModule();
      if (!mod) return;
      if (action === 'edit') {
        startEdit(id);
        return;
      }
      if (action === 'delete') {
        handleDelete(id);
        return;
      }
      const item = state.items.find((entry) => entry.id === id);
      if (!item) return;
      const handler = mod.rowActionHandlers && typeof mod.rowActionHandlers[action] === 'function'
        ? mod.rowActionHandlers[action]
        : null;
      if (handler) {
        handler({ action, id, item, module: mod, event, reload: loadList, showMessage });
        return;
      }
      if (typeof mod.hooks?.onRowAction === 'function') {
        mod.hooks.onRowAction({ action, id, item, module: mod, event, reload: loadList, showMessage });
      }
    });
  }

  dom.pagination.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page]');
    if (!button) return;
    const nextPage = Number(button.dataset.page);
    if (Number.isNaN(nextPage) || nextPage === state.page) return;
    state.page = nextPage;
    loadList({ preserveScroll: true, preserveAnchor: true });
  });

  dom.pagination.addEventListener('change', (event) => {
    const select = event.target.closest('select[data-page-size]');
    if (!select) return;
    const nextPageSize = Number(select.value);
    if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === state.pageSize) return;
    state.pageSize = nextPageSize;
    state.page = 1;
    loadList({ preserveScroll: true, preserveAnchor: true });
  });

  if (dom.toggleFormCardButton) {
    dom.toggleFormCardButton.addEventListener('click', () => {
      const mod = getCurrentModule();
      if (!mod || mod.supportsForm === false) return;
      const nextCollapsed = !state.formCollapsed;
      setFormCollapsed(nextCollapsed);
      if (!nextCollapsed && !state.editingId) {
        setFormModeCreate();
      }
    });
  }

  if (dom.toggleFiltersButton) {
    dom.toggleFiltersButton.addEventListener('click', () => {
      setFiltersCollapsed(!state.filtersCollapsed);
    });
  }

  function renderTabs() {
    const secondaryExpanded = state.secondaryTabsExpanded;
    const primaryTabs = navigation.primary
      .map((mod) => renderTabButton(mod))
      .join('');
    const secondaryGroups = navigation.secondaryGroups
      .map(
        (group) => `
          <section class="entity-tabs__group">
            <span class="entity-tabs__group-title">${escapeHtml(group.label)}</span>
            <div class="entity-tabs__group-list" role="tablist" aria-label="${escapeHtml(group.label)}">
              ${group.modules.map((mod) => renderTabButton(mod)).join('')}
            </div>
          </section>
        `
      )
      .join('');

    dom.tabs.innerHTML = `
      <div class="entity-tabs__primary" role="tablist" aria-label="Módulos principales">
        ${primaryTabs}
      </div>
      <button type="button" class="btn ghost entity-tabs__toggle" data-secondary-toggle aria-expanded="${secondaryExpanded ? 'true' : 'false'}">
        ${secondaryExpanded ? 'Ocultar más módulos' : 'Más módulos'}
      </button>
      <div class="entity-tabs__secondary${secondaryExpanded ? ' is-expanded' : ''}">
        ${secondaryGroups}
      </div>
    `;

    dom.tabs.querySelectorAll('.tab-button').forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.dataset.module;
        if (key === state.moduleKey) return;
        switchModule(key, { preserveScroll: true });
      });
    });

    const secondaryToggle = dom.tabs.querySelector('[data-secondary-toggle]');
    if (secondaryToggle) {
      secondaryToggle.addEventListener('click', () => {
        state.secondaryTabsExpanded = !state.secondaryTabsExpanded;
        syncSecondaryTabsVisibility();
      });
    }

    updateActiveTabButtons();
    syncSecondaryTabsVisibility();
  }

  function switchModule(key, options = {}) {
    const { preserveScroll = false } = options;
    const mod = moduleMap.get(key);
    if (!mod) return;

    const previousModule = getCurrentModule();
    if (previousModule && typeof previousModule.hooks?.beforeModuleChange === 'function') {
      previousModule.hooks.beforeModuleChange({ form: dom.form, module: previousModule, nextModule: mod });
    }

    state.moduleKey = key;
    state.items = [];
    state.meta = null;
    state.editingId = null;
    state.page = 1;
    state.pageSize = mod.pageSize || 20;
    state.formCollapsed = mod.supportsForm === false ? false : true;
    state.filtersCollapsed = shouldUseFilterToggle(mod) && shouldCollapseFiltersByDefault();
    if (isSecondaryModuleKey(key)) {
      state.secondaryTabsExpanded = true;
    }

    updateActiveTabButtons();
    syncSecondaryTabsVisibility();

    dom.form.reset();
    dom.searchInput.value = '';
    dom.includeDeleted.checked = false;
    if (dom.preview) {
      dom.preview.textContent = 'Esperando una solicitud...';
    }
    clearMessage();

    renderFilters(mod);
    renderFormFields(mod);
    setFormModeCreate({ autoExpand: false });
    setFormCollapsed(state.formCollapsed, mod);
    setFiltersCollapsed(state.filtersCollapsed, mod);
    renderTable([], mod);
    renderPagination(mod);

    if (typeof mod.hooks?.afterModuleChange === 'function') {
      mod.hooks.afterModuleChange({ form: dom.form, module: mod });
    }

    loadList({ preserveScroll });
  }

  async function loadList(options = {}) {
    const { preserveScroll = true, preserveAnchor = false } = options;
    const mod = getCurrentModule();
    if (!mod) return;
    const requestSeq = ++loadRequestSeq;
    const requestedModuleKey = mod.key;

    const scrollSnapshot = captureScrollSnapshot(preserveScroll, preserveAnchor);
    const filters = collectFilters(mod);

    try {
      const payload = mod.supportsPagination !== false
        ? await mod.fetchList({ page: state.page, pageSize: state.pageSize, filters })
        : await mod.fetchList({ filters });

      const { data = [], meta = null } = payload || {};

      if (requestSeq !== loadRequestSeq || state.moduleKey !== requestedModuleKey) {
        return;
      }

      state.items = Array.isArray(data) ? data : [];
      state.meta = meta;

      renderTable(state.items, mod);
      renderPagination(mod);
      restoreScrollPosition(preserveScroll, scrollSnapshot, preserveAnchor);
    } catch (error) {
      if (requestSeq !== loadRequestSeq || state.moduleKey !== requestedModuleKey) {
        return;
      }
      console.error(`[Dashboard] No se pudo cargar ${mod.key}`, error);
      showMessage(error.message || 'No se pudo cargar los registros.', 'error');
    }
  }

  function captureScrollSnapshot(shouldPreserve, shouldPreserveAnchor = false) {
    if (!shouldPreserve || typeof window === 'undefined') {
      return null;
    }
    const anchorElement = shouldPreserveAnchor ? (dom.pagination || dom.tableWrapper || dom.listCard || null) : null;
    return {
      windowY: window.scrollY || 0,
      listCardY: dom.listCard ? dom.listCard.scrollTop : null,
      anchorTop: anchorElement ? anchorElement.getBoundingClientRect().top : null
    };
  }

  function restoreScrollPosition(shouldPreserve, snapshot, shouldPreserveAnchor = false) {
    if (typeof window === 'undefined') {
      return;
    }
    const applyScroll = () => {
      if (shouldPreserve && snapshot) {
        window.scrollTo({ top: snapshot.windowY ?? 0, behavior: 'auto' });
        const anchorElement = shouldPreserveAnchor ? (dom.pagination || dom.tableWrapper || dom.listCard || null) : null;
        if (anchorElement && typeof snapshot.anchorTop === 'number') {
          const currentAnchorTop = anchorElement.getBoundingClientRect().top;
          const delta = currentAnchorTop - snapshot.anchorTop;
          if (Math.abs(delta) > 0.5) {
            window.scrollBy({ top: delta, behavior: 'auto' });
          }
        }
        if (dom.listCard && typeof snapshot.listCardY === 'number') {
          dom.listCard.scrollTop = snapshot.listCardY;
        }
        return;
      }
      if (!shouldPreserve) {
        window.scrollTo({ top: 0, behavior: 'auto' });
        if (dom.listCard) {
          dom.listCard.scrollTop = 0;
        }
      }
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(applyScroll);
      });
      if (shouldPreserve && snapshot && shouldPreserveAnchor) {
        window.setTimeout(applyScroll, 0);
        window.setTimeout(applyScroll, 80);
      }
    } else {
      applyScroll();
    }
  }

  function renderFilters(mod) {
    dom.searchInput.placeholder = mod.searchPlaceholder || 'Buscar...';
    dom.filterExtra.innerHTML = '';
    if (dom.filterForm) {
      dom.filterForm.hidden = Boolean(mod.hideFilters);
      dom.filterForm.classList.toggle('filter-form--simple', !shouldUseFilterToggle(mod));
    }
    if (dom.listActions) {
      dom.listActions.style.display = mod.hideFilters ? 'none' : '';
    }
    if (dom.toggleFiltersButton) {
      const showToggle = shouldUseFilterToggle(mod);
      dom.toggleFiltersButton.hidden = !showToggle;
      dom.toggleFiltersButton.style.display = showToggle ? '' : 'none';
    }

    if (dom.listActions) {
      let actionBar = dom.listActions.querySelector('.module-action-bar');
      if (!actionBar) {
        actionBar = document.createElement('div');
        actionBar.className = 'module-action-bar';
        dom.listActions.appendChild(actionBar);
      }
      actionBar.innerHTML = '';
      const hasModuleActions = Array.isArray(mod.moduleActions) && mod.moduleActions.length;
      if (hasModuleActions) {
        mod.moduleActions.forEach((definition) => {
          if (!definition || !definition.action || !definition.label) return;
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.moduleAction = definition.action;
          button.textContent = definition.label;
          button.className = definition.className || 'btn ghost';
          actionBar.appendChild(button);
        });
        actionBar.style.display = 'flex';
      } else {
        actionBar.style.display = 'none';
      }
    }

    if (!Array.isArray(mod.filters) || !mod.filters.length) {
      return;
    }

    const filterFields = mod.filters
      .map((filter) => buildFilterField(filter))
      .filter(Boolean)
      .join('');

    dom.filterExtra.innerHTML = filterFields;
  }

  function buildFilterField(filter) {
    const { name, label, type = 'text', options = [], placeholder = '' } = filter;
    if (!name) return '';

    if (type === 'checkbox') {
      return `
        <label class="filter-field checkbox" for="filter-${name}">
          <input type="checkbox" id="filter-${name}" name="${name}">
          <span>${label || name}</span>
        </label>
      `;
    }

    if (type === 'select') {
      const opts = options
        .map((opt) => `<option value="${opt.value}">${opt.label}</option>`)
        .join('');
      return `
        <label class="filter-field" for="filter-${name}">
          <span>${label || name}</span>
          <select id="filter-${name}" name="${name}">
            <option value="">Todos</option>
            ${opts}
          </select>
        </label>
      `;
    }

    return `
      <label class="filter-field" for="filter-${name}">
        <span>${label || name}</span>
        <input type="${type}" id="filter-${name}" name="${name}" placeholder="${placeholder}">
      </label>
    `;
  }

  function renderFormFields(mod) {
    dom.formFields.innerHTML = '';

    if (mod.supportsForm === false) {
      return;
    }

    if (!Array.isArray(mod.fields) || !mod.fields.length) {
      dom.formFields.innerHTML = '<p>No hay campos configurados.</p>';
      return;
    }

    const fieldsHtml = mod.fields
      .map((field) => buildFormField(field, mod))
      .filter(Boolean)
      .join('');

    dom.formFields.innerHTML = fieldsHtml;

    if (typeof mod.hooks?.afterFormRender === 'function') {
      mod.hooks.afterFormRender({ form: dom.form, module: mod, setVisibility });
    }
  }

  function buildFormField(field, mod) {
    const {
      name,
      label,
      type = 'text',
      required,
      placeholder = '',
      options = [],
      rows = 3,
      min,
      max,
      step,
      defaultValue,
      helperText,
      multiple,
      size
    } = field;

    if (!name) return '';

    const id = `field-${mod.key}-${name}`;
    const requiredAttr = required ? 'required' : '';
    const placeholderAttr = placeholder ? `placeholder="${escapeHtml(placeholder)}"` : '';
    const minAttr = min !== undefined ? `min="${min}"` : '';
    const maxAttr = max !== undefined ? `max="${max}"` : '';
    const stepAttr = step !== undefined ? `step="${step}"` : '';
    const defaultAttr = defaultValue !== undefined && type !== 'checkbox' ? `value="${escapeHtml(defaultValue)}"` : '';
    const multipleAttr = multiple ? 'multiple' : '';
    const sizeAttr = multiple && size ? `size="${size}"` : '';

    if (type === 'textarea') {
      return `
        <label class="form-field" for="${id}">
          <span>${label}${required ? ' *' : ''}</span>
          <textarea id="${id}" name="${name}" rows="${rows}" ${requiredAttr} ${placeholderAttr}>${
        defaultValue ? escapeHtml(defaultValue) : ''
      }</textarea>
          ${helperText ? `<small>${escapeHtml(helperText)}</small>` : ''}
        </label>
      `;
    }

    if (type === 'select') {
      const selectedValues = new Set(
        multiple && Array.isArray(defaultValue)
          ? defaultValue.map((v) => String(v))
          : defaultValue !== undefined
            ? [String(defaultValue)]
            : []
      );
      const opts = options
        .map((opt) => {
          const isSelected = selectedValues.has(String(opt.value));
          const selected = isSelected ? 'selected' : '';
          return `<option value="${escapeHtml(opt.value)}" ${selected}>${escapeHtml(opt.label)}</option>`;
        })
        .join('');
      return `
        <label class="form-field" for="${id}">
          <span>${label}${required ? ' *' : ''}</span>
          <select id="${id}" name="${name}" ${requiredAttr} ${multipleAttr} ${sizeAttr}>
            ${opts}
          </select>
          ${helperText ? `<small>${escapeHtml(helperText)}</small>` : ''}
        </label>
      `;
    }

    if (type === 'checkbox') {
      const checked = defaultValue ? 'checked' : '';
      return `
        <label class="form-field checkbox" for="${id}">
          <input type="checkbox" id="${id}" name="${name}" ${checked}>
          <span>${label}</span>
        </label>
      `;
    }

    return `
      <label class="form-field" for="${id}">
        <span>${label}${required ? ' *' : ''}</span>
        <input type="${type}" id="${id}" name="${name}" ${requiredAttr} ${placeholderAttr} ${minAttr} ${maxAttr} ${stepAttr} ${defaultAttr}>
        ${helperText ? `<small>${escapeHtml(helperText)}</small>` : ''}
      </label>
    `;
  }

  async function submitForm() {
    const mod = getCurrentModule();
    if (!mod) return;

    if (mod.supportsForm === false) {
      showMessage('Este módulo es de solo lectura.', 'info');
      return;
    }

    const payload = collectFormValues(mod);
    if (!payload) return;

    const isEditing = Boolean(state.editingId);
    const action = isEditing ? mod.actions?.editar : mod.actions?.nuevo;

    if (!action || typeof action.submit !== 'function') {
      showMessage('Esta acción no está disponible para el módulo actual.', 'info');
      return;
    }

    const transformedPayload = typeof action.transform === 'function' ? action.transform(payload) : payload;

    setSubmitting(true);
    try {
      const result = isEditing
        ? await action.submit(state.editingId, transformedPayload, payload)
        : await action.submit(transformedPayload, payload);

      const successMessage = action.successMessage || (isEditing ? `${mod.singular || mod.label} actualizado.` : `${mod.singular || mod.label} creado.`);
      showMessage(successMessage, 'success');

      setFormModeCreate();
      await loadList();
      if (typeof mod.hooks?.afterSave === 'function') {
        mod.hooks.afterSave({ result, module: mod });
      }
    } catch (error) {
      console.error(error);
      showMessage(error.message || 'No se pudo guardar el registro.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  function collectFormValues(mod) {
    if (!Array.isArray(mod.fields)) return {};

    const formData = new FormData(dom.form);
    const payload = {};

    for (const field of mod.fields) {
      const control = dom.form.elements[field.name];
      if (!control) continue;

      let value = null;
      if (control.multiple) {
        value = Array.from(control.selectedOptions || [])
          .map((opt) => opt.value)
          .filter((v) => v !== undefined && v !== null && v !== '');
      } else if (field.type === 'checkbox') {
        value = control.checked;
      } else {
        const raw = formData.get(field.name);
        if (raw === null) continue;
        value = typeof raw === 'string' ? raw.trim() : raw;
      }

      const isEmpty = Array.isArray(value) ? value.length === 0 : value === '' || value === null;

      if (isEmpty && field.required) {
        showMessage(`Completa el campo ${field.label}.`, 'error');
        control.focus();
        return null;
      }

      if (isEmpty && !field.required) {
        continue;
      }

      if (Array.isArray(value)) {
        payload[field.name] = value;
        continue;
      }

      if (field.cast) {
        value = castValue(value, field.cast);
        if (!Number.isFinite(value) && ['int', 'float', 'number'].includes(field.cast)) {
          showMessage(`Ingresa un valor numérico válido en ${field.label}.`, 'error');
          control.focus();
          return null;
        }
      }

      payload[field.name] = value;
    }

    return payload;
  }

  function castValue(value, cast) {
    if (value === '' || value === null || value === undefined) return value;
    switch (cast) {
      case 'int':
        return parseInt(value, 10);
      case 'float':
        return parseFloat(value);
      case 'number':
        return Number(value);
      case 'boolean':
        return Boolean(value);
      default:
        if (typeof cast === 'function') return cast(value);
        return value;
    }
  }

  function renderTable(items, mod) {
    const columns = Array.isArray(mod.columns) ? mod.columns : [];
    const supportsEdit = mod.supportsForm !== false && mod.supportsEdit !== false && mod.actions?.editar;
    const supportsDelete = mod.supportsDelete !== false && mod.actions?.eliminar;
    const customActions = Array.isArray(mod.rowActions) ? mod.rowActions : [];

    if (typeof mod.customRender === 'function' && dom.tableWrapper) {
      const tableElement = dom.tableElement || dom.tableWrapper.querySelector('table');
      if (tableElement) {
        tableElement.style.display = 'none';
      }
      let customContainer = dom.tableWrapper.querySelector('.module-custom-view');
      const mobileContainer = dom.tableWrapper.querySelector('.module-mobile-list');
      if (mobileContainer) {
        mobileContainer.remove();
      }
      if (!customContainer) {
        customContainer = document.createElement('div');
        customContainer.className = 'module-custom-view';
        dom.tableWrapper.appendChild(customContainer);
      }
      customContainer.innerHTML = '';
      mod.customRender({
        container: customContainer,
        items,
        module: mod,
        state,
        reload: loadList,
        showMessage,
        formatters: { formatCurrency, formatDate, formatNumber }
      });
      dom.tableHead.innerHTML = '';
      dom.tableBody.innerHTML = '';
      return;
    }

    if (dom.tableWrapper) {
      const tableElement = dom.tableElement || dom.tableWrapper.querySelector('table');
      const customContainer = dom.tableWrapper.querySelector('.module-custom-view');
      let mobileContainer = dom.tableWrapper.querySelector('.module-mobile-list');
      if (customContainer) {
        customContainer.remove();
      }
      if (!mobileContainer) {
        mobileContainer = document.createElement('div');
        mobileContainer.className = 'module-mobile-list';
        dom.tableWrapper.appendChild(mobileContainer);
      }
      if (tableElement) {
        tableElement.style.display = '';
      }
      mobileContainer.innerHTML = renderMobileCards(items, mod, { supportsEdit, supportsDelete, customActions, columns });
    }

    dom.tableHead.innerHTML = '';
    dom.tableBody.innerHTML = '';

    const headerCells = columns.map((col) => `<th>${escapeHtml(col.header || '')}</th>`);
    const hasActions = supportsEdit || supportsDelete || customActions.length > 0;
    if (hasActions) {
      headerCells.push('<th>Acciones</th>');
    }
    dom.tableHead.innerHTML = `<tr>${headerCells.join('')}</tr>`;

    if (!items.length) {
      dom.tableBody.innerHTML = `<tr class="empty-row"><td colspan="${headerCells.length}">Sin registros.</td></tr>`;
      return;
    }

    const rowsHtml = items
      .map((item) => {
        const cells = columns.map((col) => `<td>${formatCellValue(col, item)}</td>`).join('');
        const actionContext = { item, module: mod, state };
        const actions = buildRowActions(item, mod, { supportsEdit, supportsDelete, customActions });
        const actionCell = hasActions ? `<td class="actions-cell">${actions}</td>` : '';
        const rowClasses = [];
        if (item.deleted_at) rowClasses.push('is-deleted');
        if (item.stock_bajo) rowClasses.push('low-stock');
        if (state.editingId === item.id) rowClasses.push('editing');
        const classAttr = rowClasses.length ? ` class="${rowClasses.join(' ')}"` : '';
        return `<tr data-id="${item.id}"${classAttr}>${cells}${actionCell}</tr>`;
      })
      .join('');

    dom.tableBody.innerHTML = rowsHtml;
  }

  function renderMobileCards(items, mod, options) {
    const { columns = [] } = options;
    if (!items.length) {
      return '<div class="module-mobile-empty">Sin registros.</div>';
    }

    return items
      .map((item) => {
        const rowClasses = ['module-mobile-card'];
        if (item.deleted_at) rowClasses.push('is-deleted');
        if (item.stock_bajo) rowClasses.push('low-stock');
        if (state.editingId === item.id) rowClasses.push('editing');

        const titleColumn = columns[0] || null;
        const title = titleColumn ? formatCellValue(titleColumn, item) : escapeHtml(item.id || getModuleSingular(mod));
        const detailRows = columns
          .slice(1)
          .map((column) => {
            const value = formatCellValue(column, item);
            if (!value || value === '-') return '';
            return `
              <div class="module-mobile-card__detail">
                <span>${escapeHtml(column.header || '')}</span>
                <strong>${value}</strong>
              </div>
            `;
          })
          .filter(Boolean)
          .join('');

        const actions = buildRowActions(item, mod, options);

        return `
          <article class="${rowClasses.join(' ')}" data-id="${item.id}">
            <div class="module-mobile-card__header">
              <h4>${title}</h4>
              ${item.deleted_at ? '<span class="badge error">Eliminado</span>' : ''}
            </div>
            ${detailRows ? `<div class="module-mobile-card__details">${detailRows}</div>` : ''}
            ${actions ? `<div class="module-mobile-card__actions">${actions}</div>` : ''}
          </article>
        `;
      })
      .join('');
  }

  function buildRowActions(item, mod, options) {
    const { supportsEdit, supportsDelete, customActions } = options;
    const actionContext = { item, module: mod, state };
    const canEdit = typeof mod.canEdit === 'function' ? mod.canEdit(actionContext) : true;
    const canDelete = typeof mod.canDelete === 'function' ? mod.canDelete(actionContext) : true;
    let actions = '';

    if (supportsEdit && canEdit) {
      actions += `<button type="button" class="btn ghost small" data-action="edit" data-id="${item.id}">Editar</button>`;
    }
    if (supportsDelete && canDelete) {
      actions += `<button type="button" class="btn danger small" data-action="delete" data-id="${item.id}">Eliminar</button>`;
    }
    if (customActions.length) {
      customActions.forEach((definition) => {
        if (!definition || !definition.action || !definition.label) return;
        if (typeof definition.shouldRender === 'function' && !definition.shouldRender(actionContext)) {
          return;
        }
        const className = definition.className || 'btn ghost small';
        const isDisabled = typeof definition.isDisabled === 'function' ? definition.isDisabled(actionContext) : false;
        const disabledAttr = isDisabled ? ' disabled' : '';
        actions += `<button type="button" class="${className}" data-action="${definition.action}" data-id="${item.id}"${disabledAttr}>${escapeHtml(definition.label)}</button>`;
      });
    }

    return actions;
  }

  function formatCellValue(column, item) {
    if (typeof column.render === 'function') {
      return column.render(item, { formatCurrency, formatDate, formatNumber });
    }
    if (typeof column.accessor === 'function') {
      const value = column.accessor(item);
      return escapeHtml(value === undefined || value === null ? '' : String(value));
    }
    if (column.field) {
      const value = item[column.field];
      return escapeHtml(value === undefined || value === null ? '' : String(value));
    }
    return '';
  }

  function renderPagination(mod) {
    if (mod.supportsPagination === false) {
      dom.pagination.innerHTML = '';
      return;
    }

    const meta = state.meta || {};
    const currentPage = meta.page || state.page || 1;
    const totalPages = meta.totalPages || Math.max(1, Math.ceil((meta.total || 0) / (meta.pageSize || state.pageSize)));
    const total = meta.total ?? state.items.length;
    const currentPageSize = meta.pageSize || state.pageSize || mod.pageSize || 10;
    const pageSizeOptions = getPageSizeOptions(mod, currentPageSize);
    const pageButtons = buildPageButtonModel(currentPage, totalPages)
      .map((entry) => {
        if (entry === 'ellipsis') {
          return '<span class="pagination-ellipsis">…</span>';
        }
        const isActive = entry === currentPage;
        return `<button type="button" class="pager-btn pager-btn--number${isActive ? ' is-active' : ''}" data-page="${entry}" ${isActive ? 'aria-current="page"' : ''}>${entry}</button>`;
      })
      .join('');

    const prevDisabled = currentPage <= 1 ? 'disabled' : '';
    const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

    dom.pagination.innerHTML = `
      <div class="pagination-info">
        Página ${currentPage} de ${totalPages} · ${total} registros
      </div>
      <label class="pagination-size">
        <span>Ver</span>
        <select data-page-size aria-label="Cantidad de registros por página">
          ${pageSizeOptions
            .map((option) => `<option value="${option}" ${option === currentPageSize ? 'selected' : ''}>${option}</option>`)
            .join('')}
        </select>
        <span>por página</span>
      </label>
      <div class="pagination-controls">
        <button type="button" class="pager-btn" data-page="${currentPage - 1}" ${prevDisabled}>Anterior</button>
        <div class="pagination-pages">${pageButtons}</div>
        <button type="button" class="pager-btn" data-page="${currentPage + 1}" ${nextDisabled}>Siguiente</button>
      </div>
    `;
  }

  function collectFilters(mod) {
    const filters = {
      search: dom.searchInput.value.trim(),
      include_deleted: dom.includeDeleted.checked
    };

    if (Array.isArray(mod.filters)) {
      mod.filters.forEach((filter) => {
        const el = dom.filterForm.elements[filter.name];
        if (!el) return;
        if (filter.type === 'checkbox') {
          if (el.checked) {
            filters[filter.name] = true;
          }
          return;
        }
        const value = el.value?.trim();
        if (value) {
          filters[filter.name] = value;
        }
      });
    }

    return filters;
  }

  function startEdit(id) {
    const mod = getCurrentModule();
    if (!mod) return;
    if (mod.supportsForm === false) {
      showMessage('Este módulo es de solo lectura.', 'info');
      return;
    }
    const item = state.items.find((entry) => entry.id === id);
    if (!item) {
      showMessage('No se encontró el registro solicitado.', 'error');
      return;
    }

    if (typeof mod.canEdit === 'function' && !mod.canEdit({ item, module: mod, state })) {
      showMessage('Este registro ya no se puede editar.', 'info');
      return;
    }

    setFormCollapsed(false);
    setFiltersCollapsed(true, mod);
    state.editingId = id;
    if (dom.formCard) {
      dom.formCard.classList.add('is-editing');
    }
    dom.formTitle.textContent = `Editar ${getModuleSingular(mod)}`;
    dom.submitButton.textContent = 'Actualizar';
    dom.submitButton.dataset.originalText = 'Actualizar';
    dom.cancelButton.hidden = false;

    const values = typeof mod.prepareForEdit === 'function' ? mod.prepareForEdit(item) : item;

    mod.fields.forEach((field) => {
      const control = dom.form.elements[field.name];
      if (!control) return;
      const value = values[field.name];
      if (control.multiple) {
        const selection = Array.isArray(value)
          ? value.map((v) => String(v))
          : value !== undefined && value !== null
            ? [String(value)]
            : [];
        Array.from(control.options || []).forEach((opt) => {
          opt.selected = selection.includes(opt.value);
        });
      } else if (field.type === 'checkbox') {
        control.checked = Boolean(value);
      } else if (value !== undefined && value !== null) {
        control.value = value;
        if (control.tagName === 'SELECT') {
          if (control.value !== String(value)) {
            control.dataset.pendingValue = String(value);
          } else {
            delete control.dataset.pendingValue;
          }
        }
      } else if (field.defaultValue !== undefined) {
        control.value = field.defaultValue;
        if (control.tagName === 'SELECT') {
          delete control.dataset.pendingValue;
        }
      } else {
        control.value = '';
        if (control.tagName === 'SELECT') {
          delete control.dataset.pendingValue;
        }
      }
    });

    highlightRow(id);
    scrollFormCardIntoView();
    if (typeof mod.hooks?.afterEditStart === 'function') {
      mod.hooks.afterEditStart({ form: dom.form, module: mod, item: values });
    }
  }

  async function handleDelete(id) {
    const mod = getCurrentModule();
    if (!mod) return;

    const item = state.items.find((entry) => entry.id === id);
    if (item && typeof mod.canDelete === 'function' && !mod.canDelete({ item, module: mod, state })) {
      showMessage('Este registro ya no se puede eliminar.', 'info');
      return;
    }

    const action = mod.actions?.eliminar;
    if (!action || typeof action.submit !== 'function') {
      showMessage('El módulo actual no soporta eliminar registros.', 'info');
      return;
    }

    const confirmMessage = action.confirmMessage || '¿Eliminar este registro?';
    const confirmed = await confirmDialog({
      title: 'Confirmar eliminación',
      description: confirmMessage,
      confirmLabel: 'Eliminar',
      cancelLabel: 'Cancelar',
      danger: true
    });
    if (!confirmed) {
      return;
    }

    try {
      await action.submit(id);
      showMessage(action.successMessage || 'Registro eliminado.', 'success');
      if (state.editingId === id) {
        setFormModeCreate();
      }
      await loadList();
    } catch (error) {
      console.error(error);
      showMessage(error.message || 'No se pudo eliminar el registro.', 'error');
    }
  }

  function renderPreview(endpoint) {
    if (!dom.preview) return;
    dom.preview.textContent = `Consultando ${endpoint}...`;
    fetch(endpoint, { headers: { Accept: 'application/json' } })
      .then((res) => res.json())
      .then((data) => {
        dom.preview.textContent = JSON.stringify(data, null, 2);
      })
      .catch((error) => {
        dom.preview.textContent = error.message;
      });
  }

  function setFormModeCreate(options = {}) {
    const mod = getCurrentModule();
    state.editingId = null;
    const autoExpand = options.autoExpand ?? true;

    if (!mod || mod.supportsForm === false) {
      if (dom.cancelButton) {
        dom.cancelButton.hidden = true;
      }
      return;
    }

    if (autoExpand && state.formCollapsed) {
      setFormCollapsed(false);
    }
    dom.form.reset();

    if (Array.isArray(mod.fields)) {
      mod.fields.forEach((field) => {
        const control = dom.form.elements[field.name];
        if (!control) return;
        if (control.multiple) {
          const selection = Array.isArray(field.defaultValue)
            ? field.defaultValue.map((v) => String(v))
            : field.defaultValue !== undefined && field.defaultValue !== null
              ? [String(field.defaultValue)]
              : [];
          Array.from(control.options || []).forEach((opt) => {
            opt.selected = selection.includes(opt.value);
          });
        } else if (field.type === 'checkbox') {
          control.checked = Boolean(field.defaultValue);
        } else if (field.defaultValue !== undefined) {
          control.value = field.defaultValue;
          if (control.tagName === 'SELECT') {
            delete control.dataset.pendingValue;
          }
        } else {
          control.value = '';
          if (control.tagName === 'SELECT') {
            delete control.dataset.pendingValue;
          }
        }
      });
    }

  dom.formTitle.textContent = `Nuevo ${getModuleSingular(mod)}`;
    dom.submitButton.textContent = 'Guardar';
    dom.submitButton.dataset.originalText = 'Guardar';
    dom.cancelButton.hidden = true;
    if (dom.formCard) {
      dom.formCard.classList.remove('is-editing');
    }
    clearRowHighlight();

    if (typeof mod.hooks?.onResetForm === 'function') {
      mod.hooks.onResetForm({ form: dom.form, module: mod });
    }
  }

  function setFormCollapsed(collapsed, modOverride) {
    const mod = modOverride || getCurrentModule();
    const hasForm = mod?.supportsForm !== false;
    const effectiveCollapsed = hasForm ? Boolean(collapsed) : true;
    state.formCollapsed = hasForm ? effectiveCollapsed : false;
    const shouldHide = !hasForm || effectiveCollapsed;
    const focusFormLayout = Boolean(mod?.focusFormLayout) && hasForm && !shouldHide;

    if (dom.formCard) {
      dom.formCard.style.display = shouldHide ? 'none' : '';
    }
    if (dom.panelBody) {
      dom.panelBody.classList.toggle('is-form-collapsed', shouldHide);
      dom.panelBody.classList.toggle('form-focus-mode', focusFormLayout);
    }
    if (dom.listCard) {
      dom.listCard.style.display = focusFormLayout ? 'none' : '';
    }
    if (dom.listActions) {
      dom.listActions.style.display = focusFormLayout || mod?.hideFilters ? 'none' : '';
    }
    if (dom.pagination) {
      dom.pagination.style.display = focusFormLayout ? 'none' : '';
    }
    if (dom.toggleFormCardButton) {
      dom.toggleFormCardButton.hidden = !hasForm;
      dom.toggleFormCardButton.style.display = hasForm ? '' : 'none';
      if (hasForm) {
        const singular = getModuleSingular(mod);
        const openLabel = focusFormLayout ? 'Volver a la lista' : 'Ocultar formulario';
        dom.toggleFormCardButton.textContent = shouldHide ? `Nuevo ${singular}` : openLabel;
        dom.toggleFormCardButton.setAttribute('aria-expanded', (!shouldHide).toString());
        dom.toggleFormCardButton.classList.toggle('primary', shouldHide);
        dom.toggleFormCardButton.classList.toggle('ghost', !shouldHide);
      } else {
        dom.toggleFormCardButton.setAttribute('aria-expanded', 'false');
      }
    }
  }

  function setFiltersCollapsed(collapsed, modOverride) {
    const mod = modOverride || getCurrentModule();
    const hasFilters = !mod?.hideFilters;
    const canCollapse = shouldUseFilterToggle(mod);
    state.filtersCollapsed = hasFilters && canCollapse ? Boolean(collapsed) : false;

    if (dom.filterForm) {
      dom.filterForm.classList.toggle('is-collapsed-mobile', hasFilters && canCollapse && state.filtersCollapsed);
    }
    if (dom.toggleFiltersButton) {
      const showToggle = hasFilters && canCollapse;
      dom.toggleFiltersButton.hidden = !showToggle;
      dom.toggleFiltersButton.style.display = showToggle ? '' : 'none';
      dom.toggleFiltersButton.setAttribute('aria-expanded', (!state.filtersCollapsed).toString());
      dom.toggleFiltersButton.textContent = state.filtersCollapsed ? 'Mostrar filtros' : 'Ocultar filtros';
    }
  }

  function scrollFormCardIntoView() {
    if (!dom.formCard || typeof dom.formCard.scrollIntoView !== 'function') return;
    const focusTarget = dom.form?.querySelector('input, select, textarea, button');
    const performScroll = () => {
      const rect = dom.formCard.getBoundingClientRect();
      const absoluteTop = rect.top + (window.scrollY || window.pageYOffset || 0);
      const targetTop = Math.max(absoluteTop - 20, 0);
      window.scrollTo({ top: targetTop, behavior: 'smooth' });
      if (focusTarget && typeof focusTarget.focus === 'function') {
        try {
          focusTarget.focus({ preventScroll: true });
        } catch (_error) {
          focusTarget.focus();
        }
      }
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(performScroll);
      return;
    }
    performScroll();
  }

  function shouldCollapseFiltersByDefault() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  }

  function shouldUseFilterToggle(mod) {
    if (!mod || mod.hideFilters) return false;
    return Array.isArray(mod.filters) && mod.filters.length >= 2;
  }

  function renderTabButton(mod) {
    return `<button type="button" class="tab-button" data-module="${mod.key}" role="tab">${escapeHtml(mod.label)}</button>`;
  }

  function updateActiveTabButtons() {
    dom.tabs.querySelectorAll('.tab-button').forEach((tab) => {
      const isActive = tab.dataset.module === state.moduleKey;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  function syncSecondaryTabsVisibility() {
    if (!dom.tabs) return;
    const secondary = dom.tabs.querySelector('.entity-tabs__secondary');
    const toggle = dom.tabs.querySelector('[data-secondary-toggle]');
    if (!secondary || !toggle) return;
    const expanded = state.secondaryTabsExpanded;
    secondary.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.textContent = expanded ? 'Ocultar más módulos' : 'Más módulos';
  }

  function isMobileViewport() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
  }

  function isSecondaryModuleKey(key) {
    return navigation.secondaryGroups.some((group) => group.modules.some((mod) => mod.key === key));
  }

  function getPageSizeOptions(mod, currentPageSize) {
    const baseOptions = Array.isArray(mod.pageSizeOptions) && mod.pageSizeOptions.length
      ? mod.pageSizeOptions
      : [10, 20, 50];
    return [...new Set([...baseOptions, currentPageSize].filter((value) => Number.isFinite(Number(value)) && Number(value) > 0))]
      .map(Number)
      .sort((left, right) => left - right);
  }

  function buildPageButtonModel(currentPage, totalPages) {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const visible = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
    if (currentPage <= 3) {
      visible.add(2);
      visible.add(3);
      visible.add(4);
    }
    if (currentPage >= totalPages - 2) {
      visible.add(totalPages - 1);
      visible.add(totalPages - 2);
      visible.add(totalPages - 3);
    }

    const sorted = [...visible]
      .filter((page) => page >= 1 && page <= totalPages)
      .sort((left, right) => left - right);

    const model = [];
    sorted.forEach((page, index) => {
      if (index > 0 && page - sorted[index - 1] > 1) {
        model.push('ellipsis');
      }
      model.push(page);
    });
    return model;
  }

  function buildModuleNavigation(moduleList) {
    const primaryKeys = ['productos', 'clientes', 'ventas', 'pos'];
    const groupConfig = [
      { label: 'Comercial', keys: ['presupuestos', 'notasPedido', 'proveedores'] },
      { label: 'Administración', keys: ['usuarios', 'sucursales'] },
      { label: 'Operaciones', keys: ['caja'] }
    ];

    const primary = primaryKeys
      .map((key) => moduleList.find((mod) => mod.key === key))
      .filter(Boolean);

    const groupedKeys = new Set(primaryKeys);
    const secondaryGroups = groupConfig
      .map((group) => {
        const groupedModules = group.keys
          .map((key) => moduleList.find((mod) => mod.key === key))
          .filter(Boolean);
        groupedModules.forEach((mod) => groupedKeys.add(mod.key));
        return groupedModules.length ? { label: group.label, modules: groupedModules } : null;
      })
      .filter(Boolean);

    const remaining = moduleList.filter((mod) => !groupedKeys.has(mod.key));
    if (remaining.length) {
      secondaryGroups.push({ label: 'Otros', modules: remaining });
    }

    return { primary, secondaryGroups };
  }

  function toggleFormCard(mod) {
    setFormCollapsed(state.formCollapsed, mod);
  }

  function setVisibility(fieldName, visible) {
    const control = dom.form.elements[fieldName];
    if (!control) return;
    const fieldLabel = control.closest('.form-field');
    if (fieldLabel) {
      fieldLabel.style.display = visible ? '' : 'none';
    }
  }

  function highlightRow(id) {
    if (dom.tableBody) {
      dom.tableBody.querySelectorAll('tr').forEach((row) => row.classList.remove('editing'));
    }
    if (dom.tableWrapper) {
      dom.tableWrapper.querySelectorAll('.module-mobile-card').forEach((card) => card.classList.remove('editing'));
    }
    const targetRow = dom.tableBody ? dom.tableBody.querySelector(`tr[data-id="${id}"]`) : null;
    if (targetRow) targetRow.classList.add('editing');
    const targetCard = dom.tableWrapper ? dom.tableWrapper.querySelector(`.module-mobile-card[data-id="${id}"]`) : null;
    if (targetCard) targetCard.classList.add('editing');
  }

  function clearRowHighlight() {
    if (dom.tableBody) {
      dom.tableBody.querySelectorAll('tr').forEach((row) => row.classList.remove('editing'));
    }
    if (dom.tableWrapper) {
      dom.tableWrapper.querySelectorAll('.module-mobile-card').forEach((card) => card.classList.remove('editing'));
    }
  }

  function setSubmitting(isSubmitting) {
    if (!dom.submitButton) return;
    if (!dom.submitButton.dataset.originalText) {
      dom.submitButton.dataset.originalText = dom.submitButton.textContent;
    }
    dom.submitButton.disabled = isSubmitting;
    dom.submitButton.textContent = isSubmitting ? 'Guardando...' : dom.submitButton.dataset.originalText;
  }

  function showMessage(message, variant) {
    dom.feedback.textContent = message;
    dom.feedback.className = 'feedback';
    if (variant) {
      dom.feedback.classList.add(variant);
    }
  }

  function clearMessage() {
    dom.feedback.textContent = '';
    dom.feedback.className = 'feedback';
  }

  function getModuleSingular(mod) {
    if (!mod) return 'registro';
    return mod.singularLower || mod.singular || mod.labelSingular || mod.label || 'registro';
  }

  function getCurrentModule() {
    return moduleMap.get(state.moduleKey);
  }

  function getDomRefs() {
    return {
      year: document.getElementById('year'),
      preview: document.getElementById('result'),
      previewButtons: document.querySelectorAll('.actions button'),
      tabs: document.querySelector('.entity-tabs'),
      feedback: document.getElementById('feedback'),
      listActions: document.querySelector('.list-actions'),
      listCard: document.querySelector('.list-card'),
      panelBody: document.querySelector('.panel-body'),
      formCard: document.querySelector('.form-card'),
      toggleFormCardButton: document.getElementById('toggle-form-card'),
      toggleFiltersButton: document.getElementById('toggle-filters'),
      form: document.getElementById('record-form'),
      formFields: document.getElementById('form-fields'),
      formTitle: document.getElementById('form-title'),
      submitButton: document.getElementById('submit-button'),
      cancelButton: document.getElementById('cancel-edit'),
      filterForm: document.getElementById('filter-form'),
      filterExtra: document.getElementById('filter-extra'),
      searchInput: document.getElementById('search-input'),
      includeDeleted: document.getElementById('include-deleted'),
      tableWrapper: document.querySelector('.table-wrapper'),
      tableElement: document.getElementById('records-table'),
      tableHead: document.querySelector('#records-table thead'),
      tableBody: document.querySelector('#records-table tbody'),
      pagination: document.getElementById('pagination')
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
