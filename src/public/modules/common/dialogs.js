function createDialogShell({ title, description = '', width = '28rem', info = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'caja-dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = `caja-dialog${info ? ' caja-dialog--info' : ''}`;
  dialog.style.width = `min(100%, ${width})`;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const heading = document.createElement('h3');
  heading.textContent = title;
  dialog.appendChild(heading);

  if (description) {
    const descriptionNode = document.createElement('p');
    descriptionNode.className = 'caja-dialog__description';
    descriptionNode.textContent = description;
    dialog.appendChild(descriptionNode);
  }

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  return { overlay, dialog };
}

function closeDialog(overlay) {
  if (overlay?.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}

function focusWindowSafely(win) {
  if (!win || typeof win.focus !== 'function') {
    return false;
  }
  try {
    win.focus();
    return true;
  } catch (_error) {
    return false;
  }
}

export function confirmDialog({
  title,
  description = '',
  confirmLabel = 'Confirmar',
  cancelLabel = 'Cancelar',
  danger = false,
  width = '30rem'
}) {
  return new Promise((resolve) => {
    const { overlay, dialog } = createDialogShell({ title, description, width });

    const actions = document.createElement('div');
    actions.className = 'caja-dialog__actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn ghost';
    cancelButton.textContent = cancelLabel;

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = danger ? 'btn danger' : 'btn primary';
    confirmButton.textContent = confirmLabel;

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    dialog.appendChild(actions);

    const onKeydown = (event) => {
      if (!overlay.isConnected) {
        document.removeEventListener('keydown', onKeydown);
        return;
      }
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onKeydown);
        finalize(false);
      }
    };

    const finalize = (result) => {
      document.removeEventListener('keydown', onKeydown);
      closeDialog(overlay);
      resolve(result);
    };

    cancelButton.addEventListener('click', () => finalize(false));
    confirmButton.addEventListener('click', () => finalize(true));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finalize(false);
    });
    document.addEventListener('keydown', onKeydown);

    confirmButton.focus();
  });
}

export function promptDialog({
  title,
  description = '',
  field,
  confirmLabel = 'Aceptar',
  cancelLabel = 'Cancelar',
  validate
}) {
  return new Promise((resolve) => {
    const { overlay, dialog } = createDialogShell({ title, description, width: '30rem' });

    const form = document.createElement('form');
    form.className = 'caja-dialog__form';

    const label = document.createElement('label');
    label.className = 'caja-dialog__field';

    const caption = document.createElement('span');
    caption.textContent = field.label;
    label.appendChild(caption);

    const input = document.createElement('input');
    input.type = field.type || 'text';
    input.name = field.name || 'value';
    input.value = field.initialValue || '';
    input.placeholder = field.placeholder || '';
    if (field.min) input.min = field.min;
    if (field.max) input.max = field.max;
    if (field.step) input.step = field.step;
    label.appendChild(input);
    form.appendChild(label);

    const errorNode = document.createElement('p');
    errorNode.className = 'caja-dialog__description';
    errorNode.style.color = '#fca5a5';
    errorNode.style.display = 'none';
    form.appendChild(errorNode);

    const actions = document.createElement('div');
    actions.className = 'caja-dialog__actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn ghost';
    cancelButton.textContent = cancelLabel;

    const confirmButton = document.createElement('button');
    confirmButton.type = 'submit';
    confirmButton.className = 'btn primary';
    confirmButton.textContent = confirmLabel;

    actions.appendChild(cancelButton);
    actions.appendChild(confirmButton);
    form.appendChild(actions);
    dialog.appendChild(form);

    const onKeydown = (event) => {
      if (!overlay.isConnected) {
        document.removeEventListener('keydown', onKeydown);
        return;
      }
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onKeydown);
        finalize(null);
      }
    };

    const finalize = (result) => {
      document.removeEventListener('keydown', onKeydown);
      closeDialog(overlay);
      resolve(result);
    };

    cancelButton.addEventListener('click', () => finalize(null));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finalize(null);
    });
    document.addEventListener('keydown', onKeydown);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = String(input.value || '').trim();
      const validationMessage = typeof validate === 'function' ? validate(value) : '';
      if (validationMessage) {
        errorNode.textContent = validationMessage;
        errorNode.style.display = 'block';
        input.focus();
        return;
      }
      finalize(value);
    });

    input.focus();
    if (typeof input.select === 'function') {
      input.select();
    }
  });
}

export function infoDialog({ title, description = '', confirmLabel = 'Entendido', width = '36rem' }) {
  return new Promise((resolve) => {
    const { overlay, dialog } = createDialogShell({ title, description, width, info: true });
    const actions = document.createElement('div');
    actions.className = 'caja-dialog__actions';

    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'btn primary';
    confirmButton.textContent = confirmLabel;

    actions.appendChild(confirmButton);
    dialog.appendChild(actions);

    const onKeydown = (event) => {
      if (!overlay.isConnected) {
        document.removeEventListener('keydown', onKeydown);
        return;
      }
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', onKeydown);
        finalize();
      }
    };

    const finalize = () => {
      document.removeEventListener('keydown', onKeydown);
      closeDialog(overlay);
      resolve();
    };

    confirmButton.addEventListener('click', finalize);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finalize();
    });
    document.addEventListener('keydown', onKeydown);

    confirmButton.focus();
  });
}

function writePendingDocument(win, title, description) {
  if (!win || win.closed) return;
  const safeTitle = String(title || 'Preparando documento...');
  const safeDescription = String(description || 'Estamos generando el documento. Esta pestaña se actualizará automáticamente.');
  win.document.open();
  win.document.write(`<!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>${safeTitle}</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; font-family: 'Segoe UI', sans-serif; }
          .card { width: min(100% - 32px, 520px); padding: 28px; border-radius: 20px; background: linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(8, 15, 28, 0.96)); border: 1px solid rgba(148, 163, 184, 0.24); box-shadow: 0 24px 50px rgba(2, 6, 23, 0.45); }
          h1 { margin: 0 0 10px; font-size: 1.25rem; }
          p { margin: 0; color: #94a3b8; line-height: 1.55; }
          .spinner { width: 42px; height: 42px; margin-bottom: 18px; border-radius: 999px; border: 3px solid rgba(148, 163, 184, 0.25); border-top-color: #f97316; animation: spin 0.8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="spinner"></div>
          <h1>${safeTitle}</h1>
          <p>${safeDescription}</p>
        </div>
      </body>
    </html>`);
  win.document.close();
}

function writeDeferredRedirectFallback(win, url, title, description) {
  if (!win || win.closed || !url) return false;
  const safeTitle = String(title || 'Abrir documento');
  const safeDescription = String(description || 'Si el documento no se abre automáticamente, usa el botón de abajo.');
  const serializedUrl = JSON.stringify(url);
  win.document.open();
  win.document.write(`<!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8">
        <title>${safeTitle}</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e2e8f0; font-family: 'Segoe UI', sans-serif; }
          .card { width: min(100% - 32px, 560px); padding: 28px; border-radius: 20px; background: linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(8, 15, 28, 0.96)); border: 1px solid rgba(148, 163, 184, 0.24); box-shadow: 0 24px 50px rgba(2, 6, 23, 0.45); }
          h1 { margin: 0 0 10px; font-size: 1.25rem; }
          p { margin: 0 0 18px; color: #94a3b8; line-height: 1.55; }
          a { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0.75rem 1.15rem; border-radius: 999px; background: #f97316; color: #fff; text-decoration: none; font-weight: 700; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>${safeTitle}</h1>
          <p>${safeDescription}</p>
          <a id="open-document-link" href=${serializedUrl}>Abrir documento</a>
        </div>
        <script>
          try {
            window.location.href = ${serializedUrl};
          } catch (_error) {}
        </script>
      </body>
    </html>`);
  win.document.close();
  return true;
}

export function openUrlInNewTab(url, {
  blockedTitle = 'No se pudo abrir el documento',
  blockedDescription = 'Desbloquea las ventanas emergentes para continuar.',
  target = '_blank',
  features = ''
} = {}) {
  if (typeof window === 'undefined' || !url) {
    return null;
  }

  const win = window.open('', target, features);
  if (win && win.closed !== true) {
    try {
      win.opener = null;
    } catch (_error) {
    }
    try {
      win.location.href = url;
    } catch (_error) {
      try {
        win.document.location = url;
      } catch (_nestedError) {
      }
    }
    focusWindowSafely(win);
    return win;
  }

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = target;
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return {
      viaAnchor: true,
      closed: false,
      focus() {}
    };
  } catch (_error) {
    infoDialog({
      title: blockedTitle,
      description: blockedDescription
    });
    return null;
  }
}

export function createDeferredDocumentWindow({
  pendingTitle = 'Preparando documento...',
  pendingDescription = 'Estamos generando el documento. Esta pestaña se actualizará automáticamente.',
  blockedTitle = 'No se pudo abrir el documento',
  blockedDescription = 'Desbloquea las ventanas emergentes para continuar.'
} = {}) {
  if (typeof window === 'undefined') {
    return {
      blocked: true,
      navigate: () => false,
      writeHtml: () => false,
      close: () => {}
    };
  }

  const win = window.open('', '_blank');
  const blocked = !win || win.closed === true;

  if (blocked) {
    return {
      blocked: true,
      navigate: (url) => Boolean(openUrlInNewTab(url, { blockedTitle, blockedDescription })),
      writeHtml: () => {
        infoDialog({
          title: blockedTitle,
          description: blockedDescription
        });
        return false;
      },
      close: () => {}
    };
  }

  writePendingDocument(win, pendingTitle, pendingDescription);

  return {
    blocked: false,
    navigate: (url) => {
      if (!url) return false;
      try {
        win.location.href = url;
        focusWindowSafely(win);
        return true;
      } catch (_error) {
        return writeDeferredRedirectFallback(
          win,
          url,
          blockedTitle,
          'El documento se generó, pero el navegador no pudo redirigir esta pestaña automáticamente. Usa el botón para abrirlo.'
        );
      }
    },
    writeHtml: (html) => {
      try {
        win.document.open();
        win.document.write(String(html || ''));
        win.document.close();
        focusWindowSafely(win);
        return true;
      } catch (_error) {
        return false;
      }
    },
    close: () => {
      try {
        if (!win.closed) {
          win.close();
        }
      } catch (_error) {
      }
    }
  };
}