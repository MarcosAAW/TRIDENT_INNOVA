import { formatCurrency, formatDate, formatNumber } from './format.js';

export function initDashboard(modules) {
  if (!Array.isArray(modules) || !modules.length) {
    throw new Error('Debes registrar al menos un módulo.');
  }

  const moduleMap = new Map(modules.map((mod) => [mod.key, mod]));

  const state = {
    moduleKey: modules[0].key,
    items: [],
    meta: null,
    page: 1,
    pageSize: modules[0].pageSize || 20,
    editingId: null,
    formCollapsed: true
  };

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

  dom.filterForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.page = 1;
    loadList({ preserveScroll: false });
  });

  if (dom.listActions) {
    dom.listActions.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-module-action]');
      if (!button) return;
      event.preventDefault();
      const mod = getCurrentModule();
      if (!mod) return;
      const action = button.dataset.moduleAction;
      const handler = mod.moduleActionHandlers && typeof mod.moduleActionHandlers[action] === 'function'
        ? mod.moduleActionHandlers[action]
        : null;
      if (!handler) return;
      try {
        const filters = collectFilters(mod);
        handler({ action, module: mod, filters, event, reload: loadList, showMessage });
      } catch (error) {
        console.error(error);
        showMessage(error.message || 'No se pudo ejecutar la acción solicitada.', 'error');
      }
    });
  }

  dom.includeDeleted.addEventListener('change', () => {
    state.page = 1;
    loadList({ preserveScroll: false });
  });

  dom.cancelButton.addEventListener('click', () => {
    setFormModeCreate({ autoExpand: false });
    setFormCollapsed(true);
  });

  dom.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await submitForm();
  });

  dom.tableBody.addEventListener('click', (event) => {
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

  dom.pagination.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page]');
    if (!button) return;
    const nextPage = Number(button.dataset.page);
    if (Number.isNaN(nextPage) || nextPage === state.page) return;
    state.page = nextPage;
    loadList({ preserveScroll: false });
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

  function renderTabs() {
    dom.tabs.innerHTML = modules
      .map((mod) => `<button type="button" class="tab-button" data-module="${mod.key}" role="tab">${mod.label}</button>`)
      .join('');

    dom.tabs.querySelectorAll('.tab-button').forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.dataset.module;
        if (key === state.moduleKey) return;
        switchModule(key);
      });
    });
  }

  function switchModule(key) {
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

    dom.tabs.querySelectorAll('.tab-button').forEach((tab) => {
      const isActive = tab.dataset.module === key;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

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
    renderTable([], mod);
    renderPagination(mod);

    if (typeof mod.hooks?.afterModuleChange === 'function') {
      mod.hooks.afterModuleChange({ form: dom.form, module: mod });
    }

    loadList({ preserveScroll: false });
  }

  async function loadList(options = {}) {
    const { preserveScroll = true } = options;
    const mod = getCurrentModule();
    if (!mod) return;

    const scrollSnapshot = captureScrollSnapshot(preserveScroll);
    const filters = collectFilters(mod);

    try {
      const payload = mod.supportsPagination !== false
        ? await mod.fetchList({ page: state.page, pageSize: state.pageSize, filters })
        : await mod.fetchList({ filters });

      const { data = [], meta = null } = payload || {};
      state.items = Array.isArray(data) ? data : [];
      state.meta = meta;

      renderTable(state.items, mod);
      renderPagination(mod);
      restoreScrollPosition(preserveScroll, scrollSnapshot);
    } catch (error) {
      console.error(`[Dashboard] No se pudo cargar ${mod.key}`, error);
      showMessage(error.message || 'No se pudo cargar los registros.', 'error');
    }
  }

  function captureScrollSnapshot(shouldPreserve) {
    if (!shouldPreserve || typeof window === 'undefined') {
      return null;
    }
    return {
      windowY: window.scrollY || 0,
      listCardY: dom.listCard ? dom.listCard.scrollTop : null
    };
  }

  function restoreScrollPosition(shouldPreserve, snapshot) {
    if (typeof window === 'undefined') {
      return;
    }
    const applyScroll = () => {
      if (shouldPreserve && snapshot) {
        window.scrollTo({ top: snapshot.windowY ?? 0, behavior: 'auto' });
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
      window.requestAnimationFrame(applyScroll);
    } else {
      applyScroll();
    }
  }

  function renderFilters(mod) {
    dom.searchInput.placeholder = mod.searchPlaceholder || 'Buscar...';
    dom.filterExtra.innerHTML = '';
    if (dom.filterForm) {
      dom.filterForm.hidden = Boolean(mod.hideFilters);
    }
    if (dom.listActions) {
      dom.listActions.style.display = mod.hideFilters ? 'none' : '';
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
      helperText
    } = field;

    if (!name) return '';

    const id = `field-${mod.key}-${name}`;
    const requiredAttr = required ? 'required' : '';
    const placeholderAttr = placeholder ? `placeholder="${escapeHtml(placeholder)}"` : '';
    const minAttr = min !== undefined ? `min="${min}"` : '';
    const maxAttr = max !== undefined ? `max="${max}` : '';
    const stepAttr = step !== undefined ? `step="${step}"` : '';
    const defaultAttr = defaultValue !== undefined && type !== 'checkbox' ? `value="${escapeHtml(defaultValue)}"` : '';

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
      const opts = options
        .map((opt) => {
          const selected = defaultValue !== undefined && defaultValue === opt.value ? 'selected' : '';
          return `<option value="${escapeHtml(opt.value)}" ${selected}>${escapeHtml(opt.label)}</option>`;
        })
        .join('');
      return `
        <label class="form-field" for="${id}">
          <span>${label}${required ? ' *' : ''}</span>
          <select id="${id}" name="${name}" ${requiredAttr}>
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
      if (field.type === 'checkbox') {
        value = control.checked;
      } else {
        const raw = formData.get(field.name);
        if (raw === null) continue;
        value = typeof raw === 'string' ? raw.trim() : raw;
      }

      if ((value === '' || value === null) && field.required) {
        showMessage(`Completa el campo ${field.label}.`, 'error');
        control.focus();
        return null;
      }

      if ((value === '' || value === null) && !field.required) {
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
      if (customContainer) {
        customContainer.remove();
      }
      if (tableElement) {
        tableElement.style.display = '';
      }
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
        let actions = '';
        const actionContext = { item, module: mod, state };
        if (supportsEdit) {
          actions += `<button type="button" class="btn ghost small" data-action="edit" data-id="${item.id}">Editar</button>`;
        }
        if (supportsDelete) {
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

    const prevDisabled = currentPage <= 1 ? 'disabled' : '';
    const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

    dom.pagination.innerHTML = `
      <div class="pagination-info">
        Página ${currentPage} de ${totalPages} · ${total} registros
      </div>
      <div class="pagination-controls">
        <button type="button" class="pager-btn" data-page="${currentPage - 1}" ${prevDisabled}>Anterior</button>
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

    setFormCollapsed(false);
    state.editingId = id;
  dom.formTitle.textContent = `Editar ${getModuleSingular(mod)}`;
    dom.submitButton.textContent = 'Actualizar';
    dom.submitButton.dataset.originalText = 'Actualizar';
    dom.cancelButton.hidden = false;

    const values = typeof mod.prepareForEdit === 'function' ? mod.prepareForEdit(item) : item;

    mod.fields.forEach((field) => {
      const control = dom.form.elements[field.name];
      if (!control) return;
      const value = values[field.name];
      if (field.type === 'checkbox') {
        control.checked = Boolean(value);
      } else if (value !== undefined && value !== null) {
        control.value = value;
      } else if (field.defaultValue !== undefined) {
        control.value = field.defaultValue;
      } else {
        control.value = '';
      }
    });

    highlightRow(id);
    if (typeof mod.hooks?.afterEditStart === 'function') {
      mod.hooks.afterEditStart({ form: dom.form, module: mod, item: values });
    }
  }

  async function handleDelete(id) {
    const mod = getCurrentModule();
    if (!mod) return;

    const action = mod.actions?.eliminar;
    if (!action || typeof action.submit !== 'function') {
      showMessage('El módulo actual no soporta eliminar registros.', 'info');
      return;
    }

    const confirmMessage = action.confirmMessage || '¿Eliminar este registro?';
    if (!window.confirm(confirmMessage)) {
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
        if (field.type === 'checkbox') {
          control.checked = Boolean(field.defaultValue);
        } else if (field.defaultValue !== undefined) {
          control.value = field.defaultValue;
        } else {
          control.value = '';
        }
      });
    }

  dom.formTitle.textContent = `Nuevo ${getModuleSingular(mod)}`;
    dom.submitButton.textContent = 'Guardar';
    dom.submitButton.dataset.originalText = 'Guardar';
    dom.cancelButton.hidden = true;
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

    if (dom.formCard) {
      dom.formCard.style.display = shouldHide ? 'none' : '';
    }
    if (dom.panelBody) {
      dom.panelBody.classList.toggle('is-form-collapsed', shouldHide);
    }
    if (dom.toggleFormCardButton) {
      dom.toggleFormCardButton.hidden = !hasForm;
      if (hasForm) {
        const singular = getModuleSingular(mod);
        dom.toggleFormCardButton.textContent = shouldHide ? `Nuevo ${singular}` : 'Ocultar formulario';
        dom.toggleFormCardButton.setAttribute('aria-expanded', (!shouldHide).toString());
        dom.toggleFormCardButton.classList.toggle('primary', shouldHide);
        dom.toggleFormCardButton.classList.toggle('ghost', !shouldHide);
      }
    }
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
    dom.tableBody.querySelectorAll('tr').forEach((row) => row.classList.remove('editing'));
    const targetRow = dom.tableBody.querySelector(`tr[data-id="${id}"]`);
    if (targetRow) targetRow.classList.add('editing');
  }

  function clearRowHighlight() {
    dom.tableBody.querySelectorAll('tr').forEach((row) => row.classList.remove('editing'));
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
