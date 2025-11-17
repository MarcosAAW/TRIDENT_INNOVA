import { initDashboard } from './modules/common/ui.js';
import { productosModule } from './modules/productos/index.js';
import { clientesModule } from './modules/clientes/index.js';
import { ventasModule } from './modules/ventas/index.js';
import { posModule } from './modules/pos/index.js';
import { usuariosModule } from './modules/usuarios/index.js';
import { initAuth } from './modules/auth/index.js';
import { cajaModule } from './modules/caja/index.js';

document.addEventListener('DOMContentLoaded', () => {
  const modules = [productosModule, clientesModule, ventasModule, posModule, usuariosModule, cajaModule];
  let dashboardReady = false;

  initAuth({
    onAuthenticated() {
      if (dashboardReady) return;
      initDashboard(modules);
      dashboardReady = true;
    },
    onLogout() {
      window.location.reload();
    }
  });
});
