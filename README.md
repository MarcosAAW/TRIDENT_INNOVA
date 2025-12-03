# Trident Innova – Backend (API + Prisma)

Esta carpeta ya contiene un backend Express funcional conectado a PostgreSQL mediante Prisma. Incluye endpoints básicos para **productos** y **ventas**, transacciones de stock, pruebas con Jest y scripts para preparar la base con datos demo.

- **Runtime**: Node.js 18+, npm
- **ORM**: Prisma 6 + PostgreSQL
- **Testing**: Jest + Supertest

## Requisitos previos

- PostgreSQL local en `localhost:5432` (por ejemplo mediante la instalación estándar o Docker).
- Node.js 18 o superior.
- PowerShell (las instrucciones usan esta sintaxis).

## Configuración rápida

1. Clonar o abrir la carpeta del proyecto.
2. Crear `.env` definiendo la conexión a Postgres:

	```dotenv
	DATABASE_URL="postgresql://postgres:TU_PASSWORD@localhost:5432/trident_db?schema=public"
	```

3. Instalar dependencias y generar el cliente Prisma:

	```powershell
	npm ci
	npx prisma generate
	```

4. Preparar la base y cargar datos demo:

	```powershell
	npm run db:reset   # limpia tablas relacionadas y ejecuta seed
	```

	Este script crea:
	- Usuario admin (`usuario: admin`, `password_hash: changeme`).
	- Categorías “Drones” y “Repuestos”.
	- Clientes “Cliente Demo S.A.” y “Consumidor Final”.
	- Productos `DRON-001` y `REP-001` con movimientos iniciales.
	- Una venta de ejemplo (`seed-venta-001`).

5. Ejecutar pruebas de integración:

	```powershell
	npm test        # Jest ejecuta suites de clientes, productos y ventas
	```

6. Levantar el servidor Express y acceder a la vista estática:

	```powershell
	npm run dev     # usa nodemon
	# o
	npm start       # sin recarga automática
	```

	Con el servidor activo visita `http://localhost:3000/` en el navegador para usar la landing estática: incluye botones de prueba rápida y un panel modular (productos, clientes, ventas y usuarios). Cada módulo vive en `src/public/modules/<nombre>` con submódulos `nuevo.js`, `editar.js`, `eliminar.js` para organizar las operaciones. Coloca tu logo en `src/public/img/logo.png` para que aparezca en la página.

## Scripts npm disponibles

| Script          | Descripción                                                                 |
|-----------------|-----------------------------------------------------------------------------|
| `npm run dev`   | Inicia Express con nodemon (`src/index.js`).                                |
| `npm start`     | Inicia Express en modo producción.                                          |
| `npm test`      | Ejecuta Jest en modo `--runInBand`.                                         |
| `npm run lint`  | Valida `src/` y `tests/` con ESLint (sin warnings permitidos).              |
| `npm run db:check` | Conecta con Prisma y muestra un producto de ejemplo si existe.          |
| `npm run db:seed`  | Inserta usuarios, categorías, clientes, productos y una venta demo.     |
| `npm run db:reset` | Vacía tablas relacionadas (venta/producto/movimientos, etc.) y ejecuta el seed nuevamente. |

## Endpoints actuales

Servidos desde `src/app.js`:

- Rutas de productos (`/productos`): listado paginado con filtros (`page`, `pageSize`, `tipo`, `activo`, `search`, `include_deleted`); creación/edición con validación Zod; soft delete vía `DELETE /productos/:id`.
- Rutas de clientes (`/clientes`): búsqueda con filtros (`tipo_cliente`, `search`, `include_deleted`) y CRUD completo con soft delete (`DELETE /clientes/:id`).
- Rutas de ventas (`/ventas`): `GET /ventas` con filtros de búsqueda (`search`, `estado`, `iva_porcentaje`, `fecha_desde`, `fecha_hasta`, `mes`, `include_deleted`) y `POST /ventas` con transacción que descuenta stock y registra `MovimientoStock`.

> _Próximos pasos sugeridos_: CRUD de proveedores, autenticación y endpoints para revertir ventas o manejar notas de crédito.

### Vista administrativa y manejo de moneda

- **Dashboard modular**: la capa estática (`src/public/`) agrupa cada módulo en carpetas (`productos/`, `clientes/`, `ventas/`, `usuarios/`) con archivos `nuevo`, `editar` y `eliminar` en los módulos que admiten edición. El script principal (`app.js`) arma las pestañas automáticamente y ahora exige iniciar sesión antes de mostrar el panel.
- **Historial y reportes de ventas**: el módulo de ventas funciona como visor de operaciones realizadas. Incluye filtros por fecha/mes y un par de acciones para imprimir reportes diarios o mensuales (resumen de totales + detalle). El alta/edición de ventas se moverá a un módulo de punto de venta dedicado.
- **Precios de productos en USD**: los formularios de productos aceptan precios de venta y compra en dólares, piden el tipo de cambio y guardan tanto el valor original como el equivalente en guaraníes para reportes.
- **Usuarios y login**: el módulo está conectado a la API. Puedes crear, editar o desactivar usuarios, y el overlay de autenticación usa el endpoint `/auth/login` (credenciales seed: `admin` / `changeme`).

## Pruebas

Los tests (`tests/*.test.js`) son de integración: arrancan la app real y usan la base configurada en `DATABASE_URL`. Antes de cada caso se limpian tablas dependientes para evitar problemas de llaves foráneas. Para ejecutarlos:

```powershell
npm test
```

Si prefieres evitar tocar tu base local, puedes usar los seeds y reset para volver al estado inicial después de correr la suite.

## Recursos adicionales

- `DEV_SETUP.md`: guía corta para montar el entorno.
- `INFRASTRUCTURE.md`: configuración de DNS y Cloudflare.
- `scripts/`: helpers (`db-check`, `seed`, `reset`).
- `prisma/schema.prisma`: esquema en español (fuente de verdad). Mantén sincronizado `init.sql` si haces cambios.

Para colaboradores automatizados (Copilot/IA) ver `.github/copilot-instructions.md`.