import { initDashboard } from './modules/common/ui.js';
import { productosModule } from './modules/productos/index.js';
import { clientesModule } from './modules/clientes/index.js';
import { ventasModule } from './modules/ventas/index.js';
import { posModule } from './modules/pos/index.js';
import { usuariosModule } from './modules/usuarios/index.js';
import { initAuth } from './modules/auth/index.js';
import { cajaModule } from './modules/caja/index.js';

document.addEventListener('DOMContentLoaded', () => {
  const baseModules = [productosModule, clientesModule, ventasModule, posModule, usuariosModule, cajaModule];
  let dashboardReady = false;

  initAuth({
    onAuthenticated(usuario) {
      if (dashboardReady) return;
      const modules = buildModulesForRole(baseModules, usuario?.rol);
      initDashboard(modules);
      dashboardReady = true;
    },
    onLogout() {
      window.location.reload();
    }
  });
});

function buildModulesForRole(modules, role) {
  const normalizedRole = String(role || '').toUpperCase();
  return modules
    .map((module) => adaptModuleForRole(module, normalizedRole))
    .filter(Boolean);
}

function adaptModuleForRole(module, role) {
  if (!module) return null;
  if (role === 'ADMIN') {
    return module;
  }

  if (module.key === 'usuarios') {
    return null;
  }

  if (module.key === 'productos') {
    return cloneModule(module, {
      supportsForm: false,
      supportsEdit: false,
      supportsDelete: false,
      moduleActions: []
    });
  }

  if (module.key === 'ventas') {
    return cloneModule(module, {
      moduleActions: [],
      rowActions: []
    });
  }

  return module;
}

function cloneModule(module, overrides = {}) {
  const clone = { ...module, ...overrides };
  const moduleActions = overrides.moduleActions ?? module.moduleActions;
  const rowActions = overrides.rowActions ?? module.rowActions;
  clone.moduleActions = Array.isArray(moduleActions)
    ? moduleActions.map((action) => ({ ...action }))
    : moduleActions;
  clone.rowActions = Array.isArray(rowActions)
    ? rowActions.map((action) => ({ ...action }))
    : rowActions;
  return clone;
}
