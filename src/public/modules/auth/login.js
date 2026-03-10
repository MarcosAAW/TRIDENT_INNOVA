import { request } from '../common/api.js';
import {
  loadSession,
  saveSession,
  clearSession,
  refreshSessionActivity,
  startSessionWatcher,
  stopSessionWatcher,
  setActiveSucursal
} from './session.js';

export function initAuth({ onAuthenticated, onLogout } = {}) {
  const overlay = document.getElementById('auth-overlay');
  const form = document.getElementById('login-form');
  const feedback = document.getElementById('login-feedback');
  const logoutButton = document.getElementById('logout-button');
  const sessionInfo = document.getElementById('session-info');
  const sessionUser = document.getElementById('session-user');
  const sucursalActive = document.getElementById('sucursal-active');
  const sucursalPicker = document.getElementById('sucursal-picker');
  const sucursalSelector = document.getElementById('sucursal-selector');
  const usuarioInput = form?.elements.usuario;
  const passwordInput = form?.elements.password;
  const submitButton = form?.querySelector('button[type="submit"]');

  let authDispatched = false;
  let detachActivityListeners = null;
  let lastActivitySync = 0;
  const ACTIVITY_THROTTLE_MS = 30 * 1000;

  function setFeedback(message, variant) {
    if (!feedback) return;
    feedback.textContent = message || '';
    feedback.className = 'feedback';
    if (variant) {
      feedback.classList.add(variant);
    }
  }

  function showOverlay() {
    if (!overlay) return;
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('auth-pending');
    setTimeout(() => {
      usuarioInput?.focus();
    }, 100);
  }

  function hideOverlay() {
    if (!overlay) return;
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('auth-pending');
    setFeedback('');
  }

  function enableSessionGuards() {
    attachActivityListeners();
    startSessionWatcher(handleSessionExpired);
  }

  function disableSessionGuards() {
    if (typeof detachActivityListeners === 'function') {
      detachActivityListeners();
      detachActivityListeners = null;
    }
    stopSessionWatcher();
  }

  function attachActivityListeners() {
    if (detachActivityListeners) {
      return;
    }
    const events = ['click', 'keydown', 'mousemove', 'touchstart'];
    const handler = () => {
      const now = Date.now();
      if (now - lastActivitySync < ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastActivitySync = now;
      refreshSessionActivity();
    };
    events.forEach((evt) => window.addEventListener(evt, handler, { passive: true }));
    detachActivityListeners = () => {
      events.forEach((evt) => window.removeEventListener(evt, handler));
    };
  }

  function handleSessionExpired() {
    disableSessionGuards();
    clearSession();
    renderSessionInfo(null);
    resetDispatchFlag();
    showOverlay();
    setFeedback('Tu sesión expiró por inactividad. Iniciá sesión nuevamente.', 'info');
  }

  function renderSessionInfo(usuario) {
    if (!sessionInfo || !sessionUser) return;
    if (!usuario) {
      sessionInfo.hidden = true;
      sessionUser.textContent = '';
      toggleSucursalPicker(null);
      updateSucursalBadge('');
      return;
    }
    sessionInfo.hidden = false;
    sessionUser.textContent = usuario.rol ? `${usuario.nombre} · ${usuario.rol}` : usuario.nombre;
    renderSucursalSelector(usuario);
  }

  function toggleSucursalPicker(visible) {
    if (!sucursalPicker) return;
    sucursalPicker.hidden = !visible;
  }

  function renderSucursalSelector(usuario) {
    // Selector oculto: solo mostramos el badge con la sucursal activa
    const sucursales = Array.isArray(usuario?.sucursales) ? usuario.sucursales : [];
    const stored = safeGetLocalSucursal();
    const selectedId = stored || usuario.sucursalId || sucursales[0]?.sucursalId || '';
    const selectedLabel = sucursales.find((s) => s.sucursalId === selectedId)?.nombre || selectedId;

    // Mantener opciones internas (aunque el picker esté oculto) para no romper la lógica existente
    if (sucursalSelector) {
      sucursalSelector.innerHTML = sucursales
        .map((suc) => `<option value="${suc.sucursalId}">${suc.nombre || suc.sucursalId}</option>`)
        .join('');
      if (selectedId) {
        sucursalSelector.value = selectedId;
      }
    }

    setSucursal(selectedId, selectedLabel);
    toggleSucursalPicker(false);
  }

  function dispatchAuthenticated(usuario) {
    if (authDispatched) return;
    authDispatched = true;
    if (typeof onAuthenticated === 'function') {
      onAuthenticated(usuario);
    }
  }

  function resetDispatchFlag() {
    authDispatched = false;
  }

  async function handleLogin(event) {
    event.preventDefault();
    const usuario = usuarioInput?.value.trim();
    const password = passwordInput?.value.trim();

    if (!usuario || !password) {
      setFeedback('Ingresá tu usuario y contraseña.', 'error');
      usuarioInput?.focus();
      return;
    }

    setFeedback('Validando credenciales...', 'info');
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.dataset.originalText = submitButton.dataset.originalText || submitButton.textContent;
      submitButton.textContent = 'Ingresando...';
    }

    try {
      const response = await request('/auth/login', {
        method: 'POST',
        body: { usuario, password }
      });
      const usuarioAutenticado = response?.usuario;
      if (!usuarioAutenticado) {
        throw new Error('Respuesta inválida del servidor.');
      }
      setSucursal(usuarioAutenticado.sucursalId);
      saveSession(usuarioAutenticado);
      enableSessionGuards();
      renderSessionInfo(usuarioAutenticado);
      hideOverlay();
      form?.reset();
      dispatchAuthenticated(usuarioAutenticado);
    } catch (error) {
      console.error(error);
      setFeedback(error.message || 'No se pudo iniciar sesión.', 'error');
      usuarioInput?.focus();
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        if (submitButton.dataset.originalText) {
          submitButton.textContent = submitButton.dataset.originalText;
        }
      }
    }
  }

  if (form) {
    form.addEventListener('submit', handleLogin);
  }

  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      clearSession();
      safeSetLocalSucursal(null);
      renderSessionInfo(null);
      resetDispatchFlag();
      disableSessionGuards();
      if (typeof onLogout === 'function') {
        onLogout();
      }
      showOverlay();
    });
  }

  const storedSession = loadSession();
  if (storedSession) {
    const defaultSucursal = safeGetLocalSucursal() || storedSession.sucursalId || null;
    if (defaultSucursal) {
      setSucursal(defaultSucursal);
    }
    renderSessionInfo(storedSession);
    hideOverlay();
    dispatchAuthenticated(storedSession);
    enableSessionGuards();
  } else {
    showOverlay();
  }

  function setSucursal(sucursalId, label) {
    if (!sucursalId) return;
    setActiveSucursal(sucursalId);
    safeSetLocalSucursal(sucursalId);
    updateSucursalBadgeFromSelector(label);
  }

  function safeSetLocalSucursal(value) {
    try {
      if (!value) {
        window.localStorage.removeItem('sucursalId');
        return;
      }
      window.localStorage.setItem('sucursalId', value);
    } catch (error) {
      console.warn('No se pudo persistir sucursalId.', error);
    }
  }

  function safeGetLocalSucursal() {
    try {
      return window.localStorage.getItem('sucursalId');
    } catch (_err) {
      return null;
    }
  }

  if (sucursalSelector) {
    sucursalSelector.addEventListener('change', (event) => {
      const next = event.target.value;
      if (!next) return;
      setSucursal(next);
      updateSucursalBadgeFromSelector();
      window.location.reload();
    });
  }

  function updateSucursalBadge(label) {
    if (!sucursalActive) return;
    if (!label) {
      sucursalActive.hidden = true;
      sucursalActive.textContent = '';
      return;
    }
    sucursalActive.hidden = false;
    sucursalActive.textContent = label;
  }

  function updateSucursalBadgeFromSelector(label) {
    if (label) {
      updateSucursalBadge(label);
      return;
    }
    if (!sucursalSelector) return;
    const selectorLabel = sucursalSelector.options?.[sucursalSelector.selectedIndex]?.textContent || '';
    updateSucursalBadge(selectorLabel);
  }
}
