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

Si quieres que automáticemente genere `init.sql` o el scaffold (NestJS + Prisma + endpoints básicos), indícalo y lo creo.

-- Fin de notas --
