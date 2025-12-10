# Notas del proyecto — Trident Innova

Resumen de decisiones y pasos técnicos tomados en la conversación:

- Frontend: React (PWA) — instalable y con Service Worker para offline.
- Backend: Node.js con Prisma + PostgreSQL (esquema inicial en `prisma/schema.prisma`).
- Facturación: integración con la SET (Paraguay). Requiere certificado .p12 y cumplimiento del XML técnico.
- Código de barras: `jsbarcode` y `qrcode` para QR.
- Offline sync: IndexedDB/Dexie.js o PouchDB para sincronización.
- Módulo de ventas en dashboard web queda como historial con filtros (fecha/mes) y botones para imprimir reporte diario/mensual; la creación de ventas pasará a un módulo POS dedicado.

Archivos creados en esta carpeta:
- `prisma/schema.prisma` — modelo de datos en español (UUIDs, timestamps, tablas adicionales: Pago, Archivo, Certificado, Almacen, AuditLog).
- `README.md` — pasos iniciales.
- `.gitignore` — patrones básicos.

Acciones recomendadas ahora (ordenadas):
1. Abrir la carpeta en tu editor (VS Code recomendado).
2. Ejecutar los comandos de `README.md` para inicializar npm y Prisma.
3. Crear `.env` con `DATABASE_URL` apuntando a tu PostgreSQL.
4. Ejecutar `npx prisma db push` o `npx prisma migrate dev --name init`.
5. Probar con un cliente DB que las tablas se crearon.

Notas sobre facturación SET:
- Necesitarás el certificado (.p12/.pfx) y credenciales de ambiente sandbox/prod.
- Implementar firma digital del XML y manejo de reintentos.

## Facturación electrónica (SIFEN)
- Dependencia añadida: `facturacionelectronicapy-xmlgen` (modelo oficial para armar el XML).
- Configuración del emisor centralizada en `src/config/sifen.js`; completar allí los datos reales de RUC, timbrado y códigos de establecimiento.
- Servicio principal en `src/services/sifen/xmlGenerator.js`:
	```js
	const { generateFacturaElectronicaXML } = require('../services/sifen/xmlGenerator');
	const resultado = await generateFacturaElectronicaXML({ venta, detalles, cliente });
	console.log(resultado.filePath); // XML guardado en storage/facturas
	```
- Firma digital y envío:
	- `src/services/sifen/signing.js` carga el `.p12` definido por `SIFEN_CERT_PATH`/`SIFEN_CERT_PASS`, genera la firma XAdES-BES y deja el XML firmado junto al original.
	- `src/services/sifen/client.js` encapsula los endpoints del SIFEN (configurables por ambiente) y expone `sendDocumentoElectronico` + `consultarEstado`.
	- `src/services/sifen/facturaProcessor.js` orquesta: generar XML → firmar → enviar → actualizar `FacturaElectronica`.
- Flujo al generar la factura (ruta `POST /venta/:id/factura`): se dispara automáticamente el procesamiento SIFEN; si el envío falla, se deja el estado `PENDIENTE` y se registra la respuesta en `respuesta_set`.
- Catálogo geográfico oficial: ejecutar `npm run sifen:catalog` para convertir el XLSX descargado desde e-Kuatia a `docs/sifen/codigos-geograficos.json`. Utilizado por `src/services/sifen/geoCodes.js` para mapear automáticamente departamento/distrito/ciudad en el XML.
- Próximos pasos: agregar eventos (cancelación/inutilización), programar consultas periódicas al estado del CDC y exponer en el panel botones para reintentar el envío o descargar el XML firmado.

## Factura digital temporal (PDF)
- Mientras el cliente completa la certificación SIFEN se agregó un flujo de **factura digital PDF** que replica el talonario físico con timbrado vigente.
- Nuevo modelo `FacturaDigital` en Prisma/SQL para persistir numeración, totales, QR/código de control y paths de PDFs (`storage/facturas_digitales`).
- Servicio central: `src/services/facturaDigital/index.js` calcula la próxima secuencia por timbrado/punto, valida vigencia del timbrado, genera el PDF (template `pdfTemplate.js`) y guarda hash SHA256 para control de integridad.
- Configuración editable en `src/config/empresa.js` (datos corporativos y timbrado). Variables `.env`: `FACTURA_DIGITAL_TIMBRADO`, `FACTURA_DIGITAL_ESTABLECIMIENTO`, `FACTURA_DIGITAL_PUNTO`, `FACTURA_DIGITAL_VIGENCIA_INICIO`, `FACTURA_DIGITAL_VIGENCIA_FIN`.
- Para el envío automático se creó `src/services/email/facturaDigitalMailer.js` (usa `nodemailer`). Configurar `.env` con `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `FACTURA_DIGITAL_BASE_URL`.
- Endpoints nuevos: `GET /facturas-digitales/:id/pdf` (descarga autenticada) y `POST /facturas-digitales/:id/enviar` (reenviar correo opcionalmente indicando `destinatario`).
- El endpoint `POST /ventas/:id/facturar` valida que el timbrado esté vigente, genera la factura digital y, si hay correo + SMTP configurado, dispara el envío automático. A falta de SMTP queda en estado `PENDIENTE` y puede reenviarse manualmente.
- Pendientes: dashboard para ver estados/envíos, colas de reintento y respaldo automatizado de `storage/facturas_digitales`.

Si quieres que automáticemente genere `init.sql` o el scaffold (NestJS + Prisma + endpoints básicos), indícalo y lo creo.

-- Fin de notas --
