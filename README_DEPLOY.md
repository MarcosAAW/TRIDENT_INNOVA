# Guía de despliegue rápido (VPS)

## Estado actual
- Código en VPS (`/opt/trident-app`) ya actualizado con `git pull`.
- Dependencias instaladas con `npm ci` (warnings de paquetes deprecados y 11 vulnerabilidades reportadas por npm, no bloqueantes para prod actual).
- Base local limpia y reseedeada; en prod no se ejecutó reset.
- Certificados/llaves SIFEN pendientes para próximo deploy.

## Pasos en el VPS (/opt/trident-app)
1. Aplicar migraciones y regenerar Prisma:
   ```
   npx prisma migrate deploy
   npx prisma generate
   ```
2. Reiniciar el servicio (PM2):
   ```
   pm2 restart trident
   pm2 status
   pm2 logs trident --lines 50
   ```
3. Chequeo rápido:
   ```
   curl -f http://localhost:3000/health || true
   ```

## Notas
- No correr `scripts/reset.js` en prod; solo `migrate deploy`.
- Para staging/tests en el VPS puedes usar `node scripts/sales-scenarios-check.js` (requiere datos de prueba, crea usuario/sucursal/cliente/producto si faltan).
- Próximo deploy: incluir certificados y claves SIFEN en las rutas configuradas en `.env`.
