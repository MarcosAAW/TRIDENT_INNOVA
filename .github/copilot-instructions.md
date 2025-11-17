## Copilot / AI agent instructions — Trident Innova (backend)

Short goal: be productive making backend changes that integrate with Prisma + PostgreSQL, respecting the existing DB-first schema and naming conventions.

- Project type: Node.js (CommonJS) with Prisma ORM and PostgreSQL. Minimal application code is present; repo focuses on DB schema and notes.
- Key files:
  - `prisma/schema.prisma` — canonical data model (Spanish field names, UUID primary keys, enums).
  - `init.sql` — SQL implementation of the Prisma schema for manual DB setup.
  - `docker-compose.yml` — local Postgres service (container name: `trident_postgres`, port 5432).
  - `README.md` / `NOTAS_PROYECTO.md` — onboarding steps and recommended PowerShell commands.

Important patterns and constraints to preserve:
- Database-first mindset: Prisma schema is the source of truth for models and enums. Keep `prisma/schema.prisma` synchronized with any SQL or migration changes.
- UUID PKs everywhere. Use UUIDs (Prisma default uuid()) when creating records in code or migrations.
- Soft deletes: many models use a `deleted_at` timestamp instead of hard-delete. Prefer setting `deleted_at` when deleting unless a new model explicitly differs.
- Timestamps: `created_at` default now(), `updated_at` uses @updatedAt / updated timestamp behavior. Preserve these columns in any DB changes.
- Money and precision: monetary fields use Decimal / numeric with fixed precision (e.g., Decimal(12,2)). Use Decimal types in code (Prisma Decimal or string) and take care when summing/formatting.
- Enums: Prisma enums (e.g., `TipoProducto`, `RolUsuario`) are used widely. If you add new enum values, update both Prisma and any code consuming them.

Developer workflows (explicit commands — PowerShell examples):
- Create `.env` with `DATABASE_URL`. Example:
  DATABASE_URL="postgresql://trident:tridentpass@localhost:5432/trident_db?schema=public"
- Start local DB (from repo root):
  docker-compose up -d
- Apply schema via Prisma (fast push):
  npx prisma db push
  npx prisma generate
- Or use migrations (recommended for development):
  npx prisma migrate dev --name init
  npx prisma generate
- To run SQL directly (manual DB):
  psql -h <host> -U <user> -d <db> -f init.sql

Integration points / external dependencies to be aware of:
- Facturación electrónica (SET Paraguay): `FacturaElectronica` model includes `respuesta_set`, `xml_path`, `pdf_path`, `intentos` and `ambiente` — code that integrates with SET should read/write these fields and handle retry logic. Look for `Certificado` and `archivo` models when dealing with signing/certificates.
- Files: `Archivo` model stores uploaded file metadata (ruta). Code should persist files on a storage layer and keep DB pointers here.

Conventions & naming:
- Field names are Spanish and frequently use snake_case (e.g., `nombre_razon_social`, `precio_venta`). Follow existing naming when adding new fields.
- Table/model pluralization: Prisma models are singular (e.g., `Producto`) and SQL tables use lowercase snake (e.g., `producto`). Keep mapping consistent.
- Audit: `AuditLog` captures changes; prefer creating audit entries when mutating critical models (ventas, compras, productos).

What to do when changing the schema:
1. Update `prisma/schema.prisma` first.
2. Run `npx prisma migrate dev --name <desc>` to create a migration and apply locally.
3. Run `npx prisma generate` and update any code using the client.
4. If a manual SQL change is needed, update `init.sql` to reflect it.

Examples found in repo to reference when coding:
- `prisma/schema.prisma` — enums (TipoProducto, RolUsuario), soft-delete pattern, Decimal fields.
- `init.sql` — concrete SQL translation and indices (idx_producto_sku, idx_venta_fecha).
- `docker-compose.yml` — Postgres service definition, credentials and port mapping.

Edge cases for implementers:
- Currency conversions: sales default `moneda` to "PYG" and include an optional `tipo_cambio` field — handle null safely.
- Facturación retries: `intentos` field present; ensure idempotence when re-sending to SET.
- Legacy data: nullability is used for many relationships (venta.clienteId optional). Code must handle absent relations.

If you need more context or find divergent content (an existing `.github/copilot-instructions.md` or `AGENT.md`), merge carefully: keep repository-specific commands and examples above generic guidance. After edits, run `npx prisma generate` and ensure code compiles and DB migrations apply.

Quick checklist for PRs touching DB:
- Update `prisma/schema.prisma` and create a migration.
- Update or regenerate `init.sql` if manual deployment uses it.
- Add tests or a small script that demonstrates the migration works locally (optional but helpful).

Ask me to expand any section (deployment, auth, or SET integration) or to produce sample API scaffolding using `@prisma/client` and Express/NestJS.
