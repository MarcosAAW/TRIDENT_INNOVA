# Estado temporal (multi-sucursal, crédito, pagos/recibos)

## Cambios principales
- Sucursales: middleware `requireSucursal` exige `x-sucursal-id` y valida membresía (`usuario_sucursal`).
- Factura digital: guarda `sucursalId`, secuencia por sucursal y rutas protegidas por auth+sucursal.
- Front: siempre envía `x-sucursal-id` (lee de query/localStorage/sesión) en `src/public/modules/common/api.js`.
- Crédito y ventas: Venta tiene `es_credito`, `saldo_pendiente`, `fecha_vencimiento`, `condicion_venta`; tablas relacionadas incluyen `sucursalId`.
- Pagos: nueva ruta `/pagos` crea y lista pagos por sucursal, descuenta saldo y marca venta pagada cuando llega a 0.
- Recibos: nueva ruta `/recibos` crea recibos con aplicaciones a ventas (mismo control de sucursal), actualiza saldos.
- Migración creada y aplicada: `prisma/migrations/20260207140938_sucursal_scoping_factura` (sucursales, crédito en venta, pagos/recibos, sucursalId en caja/facturas).

## Rutas nuevas
- `POST /pagos` — body: `{ ventaId, monto, metodo, referencia?, fecha_pago? }`
- `GET /pagos?ventaId=` — lista pagos de la sucursal actual.
- `POST /recibos` — body: `{ clienteId?, numero?, metodo, referencia?, observacion?, fecha?, ventas: [{ ventaId, monto }] }`
- `GET /recibos` — filtros opcionales: `clienteId`, `fecha_desde`, `fecha_hasta`.
- `GET /recibos/:id`
- Todas requieren `x-user-id` y `x-sucursal-id` válidos.

## Factura digital legacy
- Compatibilidad sólo para comprobantes históricos previos a FactPy.
- Generación incluye `sucursalId` y secuencia por sucursal.
- Endpoints `/facturas-digitales/:id/pdf` y `/facturas-digitales/:id/enviar` filtran por sucursal y requieren auth+sucursal.
- En producción la ruta no se monta por defecto; para habilitarla explícitamente usar `FACTURA_DIGITAL_LEGACY_ENABLED=true`.

## Factura electrónica vía FactPy (API)
- Endpoint principal: `POST /ventas/:id/facturar` (auth + sucursal) crea/actualiza `FacturaElectronica` con número placeholder `001-001-<id7>` y timbrado `12545678-01`, genera PDF/XML locales y, si hay `FACTPY_RECORD_ID`, arma el payload FactPy y lo envía ([src/routes/venta.js](src/routes/venta.js#L526-L705)).
- Payload que enviamos a FactPy: `receiptid` = venta.id, `establecimiento`/`punto` del timbrado de empresa, `numero` = secuencia (7 dígitos), `cliente` (ruc/nombre), `items` (desc, cantidad, precioUnitario), `pagos` y `totalPago` ([src/routes/venta.js](src/routes/venta.js#L1504-L1544)).
- Respuesta FactPy al emitir: guardamos en `FacturaElectronica.respuesta_set` el objeto completo, más `receiptid` del payload; si trae `kude` o `xmlLink`, los persistimos en `pdf_path`/`xml_path`; si trae `cdc`, se guarda en `qr_data`; estado se marca `ENVIADO` o `RECHAZADO` según `status` ([src/routes/venta.js](src/routes/venta.js#L600-L665)).
- Polling de estados: `POST /factpy/poll` (auth + sucursal) busca facturas `ENVIADO`/`PENDIENTE`, arma `receiptid` desde `respuesta_set` o `ventaId`, consulta FactPy y actualiza `estado` a `ACEPTADO`/`RECHAZADO` si el texto incluye “aprob”/“rechaz”; también copia `cdc` a `qr_data` y `documento` a `nro_factura` cuando vienen en la respuesta ([src/routes/factpy.js](src/routes/factpy.js#L12-L180)).
- Configuración `.env`: `FACTPY_BASE_URL` (default `https://api.factpy.com/facturacion-api`), `FACTPY_RECORD_ID` (obligatorio para emitir), `FACTPY_TIMEOUT_MS` (default 15000 ms). Validación mínima: si falta `FACTPY_RECORD_ID`, la emisión FactPy no se dispara ([src/services/factpy/client.js](src/services/factpy/client.js), [src/config/factpy.js](src/config/factpy.js)).
- Persistencia y sucursales: todas las consultas/updates de FactPy se filtran por `sucursalId`; paths devuelven rutas web (`/storage/facturas/...`) cuando FactPy entrega `kude/xmlLink`.
- Notas: el código SIFEN nativo sigue disponible pero no es el flujo activo; la vía actual es la API de FactPy con polling.

## Front (header sucursal)
- `src/public/modules/common/api.js` agrega `x-sucursal-id` leyendo en orden: query `sucursalId` (si está, se guarda en localStorage) -> localStorage -> sesión.

## DB y Prisma
- Esquema actualizado en `prisma/schema.prisma` e `init.sql` (incluye Sucursal, UsuarioSucursal, Recibo, ReciboDetalle, crédito en Venta, sucursalId en caja/facturas/pagos).
- Migración aplicada: `20260207140938_sucursal_scoping_factura`.
- Falta generar Prisma Client: `npx prisma generate --schema prisma/schema.prisma` falla en OneDrive por bloqueo del engine (`query_engine-windows.dll.node`). Se intentó limpiar `.prisma` y usar junction fuera de OneDrive, sigue dando `UNKNOWN: unknown error, read`.

## Para destrabar `prisma generate`
1) Pausar OneDrive (hecho). Si persiste, mover la carpeta o solo `.prisma` fuera de OneDrive o excluirla en antivirus/Defender.
2) En una ruta fuera de OneDrive (recomendado `C:\dev\Trident_Innova`):
   - `npm ci`
   - `npx prisma generate --schema prisma/schema.prisma`
3) Si sigue el lock: matar procesos que usen `query_engine-windows.dll.node` (Resmon), y reintentar.

## Comandos útiles
- Migrar (ya aplicada localmente): `npx prisma migrate dev --name sucursal-scoping-factura`
- Generar cliente (cuando se libere el lock): `npx prisma generate --schema prisma/schema.prisma`
- Semillas/resets previos: `npm run seed` (si existe), `node scripts/reset.js` (según scripts del repo).

## Archivos clave tocados
- `src/services/facturaDigital/index.js`
- `src/routes/facturaDigital.js`
- `src/public/modules/common/api.js`
- `src/routes/pago.js`
- `src/routes/recibo.js`
- `src/app.js`
- `prisma/schema.prisma`
- `prisma/migrations/20260207140938_sucursal_scoping_factura/migration.sql`
- `init.sql`

## Pendientes
- Ejecutar `npx prisma generate` (resolver lock de OneDrive/antivirus).
- Probar end-to-end: creación de ventas crédito, pagos, recibos y factura digital filtrando por sucursal.
- Asegurar que el frontend envía `x-sucursal-id` en todas las vistas (ya se inyecta en requests; falta UX para elegir sucursal si corresponde).
- Ajustar numeración/timbrado reales de `FacturaElectronica` (reemplazar placeholder `generarNumeroFactura` y timbrado `12545678-01`, secuencia por sucursal/timbrado).
- Consumir y persistir por defecto CDC/nro de la respuesta de FactPy, y exponer reintento/consulta desde el panel usando `/factpy/poll`.

## Tests
- `npm test` pasa (se mockean auth/sucursal en tests y se stubbean FactPy/SIFEN en `tests/venta.test.js`; `FakePrisma` agrega `venta.findFirst`).
- Para pruebas manuales con FactPy (sin enviar a SIFEN): con `FACTPY_RECORD_ID` del cert de FactPy y `SIFEN_ENABLE=false` (o sin cert `SIFEN_CERT_PATH`), `POST /ventas/:id/facturar` usa solo FactPy y devuelve `kude/xmlLink` si la validación pasa.

## Tests
- `npm test` pasa (se mockean auth/sucursal en tests y se stubbean FactPy/SIFEN en `tests/venta.test.js`; `FakePrisma` agrega `venta.findFirst`).
