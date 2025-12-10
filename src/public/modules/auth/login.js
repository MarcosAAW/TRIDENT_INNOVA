import { request } from '../common/api.js';
import {
  loadSession,
  saveSession,
  clearSession,
  refreshSessionActivity,
  startSessionWatcher,
  stopSessionWatcher
} from './session.js';

export function initAuth({ onAuthenticated, onLogout } = {}) {
  const overlay = document.getElementById('auth-overlay');
  const form = document.getElementById('login-form');
  const feedback = document.getElementById('login-feedback');
  const logoutButton = document.getElementById('logout-button');
  const sessionInfo = document.getElementById('session-info');
  const sessionUser = document.getElementById('session-user');
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
      return;
    }
    sessionInfo.hidden = false;
    sessionUser.textContent = usuario.rol ? `${usuario.nombre} · ${usuario.rol}` : usuario.nombre;
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
    renderSessionInfo(storedSession);
    hideOverlay();
    dispatchAuthenticated(storedSession);
    enableSessionGuards();
  } else {
    showOverlay();
  }
}
