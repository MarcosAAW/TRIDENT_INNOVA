const STORAGE_KEY = 'trident_innova_usuario_activo';
const STORAGE_VERSION = 1;
const MAX_AGE_MINUTES = 12 * 60; // 12 horas máx.
const IDLE_TIMEOUT_MINUTES = 30; // 30 minutos sin actividad.
const CHECK_INTERVAL_MS = 60 * 1000;

let watcherHandle = null;

export function loadSession() {
  const envelope = readActiveEnvelope();
  return envelope?.usuario ?? null;
}

export function saveSession(usuario) {
  if (!usuario) {
    clearSession();
    return null;
  }
  const envelope = buildEnvelope(usuario);
  persistEnvelope(envelope);
  return envelope.usuario;
}

export function clearSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('No se pudo limpiar la sesión.', error);
  }
}

export function refreshSessionActivity() {
  const envelope = readActiveEnvelope();
  if (!envelope) return null;
  envelope.lastActivity = Date.now();
  envelope.idleExpiresAt = envelope.lastActivity + minutesToMs(IDLE_TIMEOUT_MINUTES);
  persistEnvelope(envelope);
  return envelope.usuario;
}

export function startSessionWatcher(onExpire) {
  stopSessionWatcher();
  if (typeof window === 'undefined') return;
  watcherHandle = window.setInterval(() => {
    const envelope = readEnvelope();
    if (!envelope) {
      return;
    }
    if (isEnvelopeExpired(envelope)) {
      clearSession();
      stopSessionWatcher();
      if (typeof onExpire === 'function') {
        onExpire();
      }
    }
  }, CHECK_INTERVAL_MS);
}

export function stopSessionWatcher() {
  if (watcherHandle) {
    window.clearInterval(watcherHandle);
    watcherHandle = null;
  }
}

function readActiveEnvelope() {
  const envelope = readEnvelope();
  if (!envelope) return null;
  if (isEnvelopeExpired(envelope)) {
    clearSession();
    return null;
  }
  return envelope;
}

function readEnvelope() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch (error) {
    console.error('No se pudo cargar la sesión previa.', error);
    return null;
  }
}

function buildEnvelope(usuario) {
  const now = Date.now();
  return {
    version: STORAGE_VERSION,
    usuario,
    createdAt: now,
    lastActivity: now,
    idleExpiresAt: now + minutesToMs(IDLE_TIMEOUT_MINUTES),
    absoluteExpiresAt: now + minutesToMs(MAX_AGE_MINUTES)
  };
}

function persistEnvelope(envelope) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch (error) {
    console.error('No se pudo guardar la sesión.', error);
  }
}

function isEnvelopeExpired(envelope) {
  if (!envelope) return true;
  const now = Date.now();
  if (now >= envelope.absoluteExpiresAt) {
    return true;
  }
  if (now >= envelope.idleExpiresAt) {
    return true;
  }
  return false;
}

function minutesToMs(minutes) {
  return minutes * 60 * 1000;
}
