const STORAGE_KEY = 'trident_innova_usuario_activo';

export function loadSession() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (error) {
    console.error('No se pudo cargar la sesión previa.', error);
    return null;
  }
}

export function saveSession(usuario) {
  try {
    if (!usuario) {
      clearSession();
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(usuario));
  } catch (error) {
    console.error('No se pudo guardar la sesión.', error);
  }
}

export function clearSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('No se pudo limpiar la sesión.', error);
  }
}
