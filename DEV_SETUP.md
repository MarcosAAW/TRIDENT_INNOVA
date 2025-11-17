# Comprobar conexión a la base de datos (rápido)

Sigue estos pasos para verificar que Prisma puede conectarse a la base de datos localmente.

1. Copia el ejemplo y crea tu `.env` en la raíz del proyecto:

```powershell
cp .env.example .env
# Edita .env con las credenciales correctas si es necesario
```

2. Levanta el contenedor de Postgres (desde la raíz del repo):

```powershell
docker-compose up -d
```

3. Instala dependencias (si no lo hiciste) y genera el cliente Prisma:

```powershell
npm install
npx prisma generate
```

4. Ejecuta el chequeo rápido:

```powershell
npm run db:check
```

Salida esperada: `Conexión OK` y datos de ejemplo del primer registro en `producto` o un mensaje indicando que la tabla está vacía.

Nota: el endpoint POST `/ventas` del scaffold API ahora realiza, dentro de la misma transacción:
- creación de la `venta` y sus `detalles`
- decrementar `producto.stock_actual` por la cantidad vendida (si la columna existe)
- crear un registro en `movimiento_stock` con `tipo = SALIDA` por cada detalle

Si el stock es insuficiente para algún producto la transacción se revierte y el endpoint devuelve 400 con un mensaje indicando el producto afectado.
