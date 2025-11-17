/*
  Warnings:

  - The primary key for the `almacen` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `archivo` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `audit_log` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `categoria` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `certificado` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `cliente` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `compra` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `detalle_compra` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `detalle_venta` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `factura_electronica` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `movimiento_stock` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `pago` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `producto` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `proveedor` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `usuario` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `venta` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Made the column `created_at` on table `almacen` required. This step will fail if there are existing NULL values in that column.
  - Made the column `subido_en` on table `archivo` required. This step will fail if there are existing NULL values in that column.
  - Made the column `creado_en` on table `audit_log` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `categoria` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `categoria` required. This step will fail if there are existing NULL values in that column.
  - Made the column `huella` on table `certificado` required. This step will fail if there are existing NULL values in that column.
  - Made the column `activo` on table `certificado` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `certificado` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `cliente` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `cliente` required. This step will fail if there are existing NULL values in that column.
  - Made the column `fecha` on table `compra` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `compra` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `compra` required. This step will fail if there are existing NULL values in that column.
  - Made the column `intentos` on table `factura_electronica` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `factura_electronica` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `factura_electronica` required. This step will fail if there are existing NULL values in that column.
  - Made the column `fecha` on table `movimiento_stock` required. This step will fail if there are existing NULL values in that column.
  - Made the column `fecha_pago` on table `pago` required. This step will fail if there are existing NULL values in that column.
  - Made the column `stock_actual` on table `producto` required. This step will fail if there are existing NULL values in that column.
  - Made the column `activo` on table `producto` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `producto` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `producto` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `proveedor` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `proveedor` required. This step will fail if there are existing NULL values in that column.
  - Made the column `activo` on table `usuario` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `usuario` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `usuario` required. This step will fail if there are existing NULL values in that column.
  - Made the column `fecha` on table `venta` required. This step will fail if there are existing NULL values in that column.
  - Made the column `created_at` on table `venta` required. This step will fail if there are existing NULL values in that column.
  - Made the column `updated_at` on table `venta` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "public"."compra" DROP CONSTRAINT "compra_proveedor_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."detalle_compra" DROP CONSTRAINT "detalle_compra_compra_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."detalle_compra" DROP CONSTRAINT "detalle_compra_producto_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."detalle_venta" DROP CONSTRAINT "detalle_venta_producto_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."detalle_venta" DROP CONSTRAINT "detalle_venta_venta_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."factura_electronica" DROP CONSTRAINT "factura_electronica_venta_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."movimiento_stock" DROP CONSTRAINT "movimiento_stock_producto_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."pago" DROP CONSTRAINT "pago_venta_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."producto" DROP CONSTRAINT "producto_categoria_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."venta" DROP CONSTRAINT "venta_cliente_id_fkey";

-- DropForeignKey
ALTER TABLE "public"."venta" DROP CONSTRAINT "venta_usuario_id_fkey";

-- DropIndex
DROP INDEX "public"."idx_cliente_ruc";

-- DropIndex
DROP INDEX "public"."idx_movimiento_producto";

-- DropIndex
DROP INDEX "public"."idx_producto_codigo_barra";

-- DropIndex
DROP INDEX "public"."idx_producto_sku";

-- DropIndex
DROP INDEX "public"."idx_venta_fecha";

-- AlterTable
ALTER TABLE "almacen" DROP CONSTRAINT "almacen_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "nombre" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "almacen_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "archivo" DROP CONSTRAINT "archivo_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "tipo_entidad" SET DATA TYPE TEXT,
ALTER COLUMN "entidad_id" SET DATA TYPE TEXT,
ALTER COLUMN "nombre" SET DATA TYPE TEXT,
ALTER COLUMN "mime" SET DATA TYPE TEXT,
ALTER COLUMN "subido_por" SET DATA TYPE TEXT,
ALTER COLUMN "subido_en" SET NOT NULL,
ALTER COLUMN "subido_en" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "archivo_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "usuario_id" SET DATA TYPE TEXT,
ALTER COLUMN "accion" SET DATA TYPE TEXT,
ALTER COLUMN "tabla" SET DATA TYPE TEXT,
ALTER COLUMN "registro_id" SET DATA TYPE TEXT,
ALTER COLUMN "creado_en" SET NOT NULL,
ALTER COLUMN "creado_en" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "categoria" DROP CONSTRAINT "categoria_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "nombre" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "categoria_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "certificado" DROP CONSTRAINT "certificado_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "huella" SET NOT NULL,
ALTER COLUMN "huella" SET DATA TYPE TEXT,
ALTER COLUMN "valido_desde" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "valido_hasta" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "ambiente" SET DATA TYPE TEXT,
ALTER COLUMN "activo" SET NOT NULL,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "certificado_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "cliente" DROP CONSTRAINT "cliente_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "nombre_razon_social" SET DATA TYPE TEXT,
ALTER COLUMN "ruc" SET DATA TYPE TEXT,
ALTER COLUMN "telefono" SET DATA TYPE TEXT,
ALTER COLUMN "correo" SET DATA TYPE TEXT,
ALTER COLUMN "tipo_cliente" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "cliente_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "compra" DROP CONSTRAINT "compra_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "proveedor_id" SET DATA TYPE TEXT,
ALTER COLUMN "fecha" SET NOT NULL,
ALTER COLUMN "fecha" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "estado" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "compra_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "detalle_compra" DROP CONSTRAINT "detalle_compra_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "compra_id" SET DATA TYPE TEXT,
ALTER COLUMN "producto_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "detalle_compra_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "detalle_venta" DROP CONSTRAINT "detalle_venta_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "venta_id" SET DATA TYPE TEXT,
ALTER COLUMN "producto_id" SET DATA TYPE TEXT,
ADD CONSTRAINT "detalle_venta_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "factura_electronica" DROP CONSTRAINT "factura_electronica_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "venta_id" SET DATA TYPE TEXT,
ALTER COLUMN "nro_factura" SET DATA TYPE TEXT,
ALTER COLUMN "timbrado" SET DATA TYPE TEXT,
ALTER COLUMN "fecha_emision" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "estado" SET DEFAULT 'PENDIENTE',
ALTER COLUMN "intentos" SET NOT NULL,
ALTER COLUMN "ambiente" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "factura_electronica_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "movimiento_stock" DROP CONSTRAINT "movimiento_stock_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "producto_id" SET DATA TYPE TEXT,
ALTER COLUMN "motivo" SET DATA TYPE TEXT,
ALTER COLUMN "referencia_id" SET DATA TYPE TEXT,
ALTER COLUMN "referencia_tipo" SET DATA TYPE TEXT,
ALTER COLUMN "almacen_id" SET DATA TYPE TEXT,
ALTER COLUMN "usuario_id" SET DATA TYPE TEXT,
ALTER COLUMN "fecha" SET NOT NULL,
ALTER COLUMN "fecha" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "movimiento_stock_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "pago" DROP CONSTRAINT "pago_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "venta_id" SET DATA TYPE TEXT,
ALTER COLUMN "fecha_pago" SET NOT NULL,
ALTER COLUMN "fecha_pago" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "metodo" SET DATA TYPE TEXT,
ALTER COLUMN "referencia" SET DATA TYPE TEXT,
ADD CONSTRAINT "pago_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "producto" DROP CONSTRAINT "producto_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "sku" SET DATA TYPE TEXT,
ALTER COLUMN "nombre" SET DATA TYPE TEXT,
ALTER COLUMN "moneda_precio_venta" SET DATA TYPE TEXT,
ALTER COLUMN "moneda_precio_compra" SET DATA TYPE TEXT,
ALTER COLUMN "stock_actual" SET NOT NULL,
ALTER COLUMN "codigo_barra" SET DATA TYPE TEXT,
ALTER COLUMN "categoria_id" SET DATA TYPE TEXT,
ALTER COLUMN "unidad" SET DATA TYPE TEXT,
ALTER COLUMN "activo" SET NOT NULL,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "producto_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "proveedor" DROP CONSTRAINT "proveedor_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "nombre_razon_social" SET DATA TYPE TEXT,
ALTER COLUMN "ruc" SET DATA TYPE TEXT,
ALTER COLUMN "contacto" SET DATA TYPE TEXT,
ALTER COLUMN "telefono" SET DATA TYPE TEXT,
ALTER COLUMN "correo" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "proveedor_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "usuario" DROP CONSTRAINT "usuario_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "nombre" SET DATA TYPE TEXT,
ALTER COLUMN "usuario" SET DATA TYPE TEXT,
ALTER COLUMN "password_hash" SET DATA TYPE TEXT,
ALTER COLUMN "rol" SET DEFAULT 'ADMIN',
ALTER COLUMN "activo" SET NOT NULL,
ALTER COLUMN "last_login" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "usuario_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "venta" DROP CONSTRAINT "venta_pkey",
ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "id" SET DATA TYPE TEXT,
ALTER COLUMN "cliente_id" SET DATA TYPE TEXT,
ALTER COLUMN "usuario_id" SET DATA TYPE TEXT,
ALTER COLUMN "fecha" SET NOT NULL,
ALTER COLUMN "fecha" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "estado" SET DATA TYPE TEXT,
ALTER COLUMN "factura_electronica_id" SET DATA TYPE TEXT,
ALTER COLUMN "moneda" SET DATA TYPE TEXT,
ALTER COLUMN "created_at" SET NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" SET NOT NULL,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "deleted_at" SET DATA TYPE TIMESTAMP(3),
ADD CONSTRAINT "venta_pkey" PRIMARY KEY ("id");

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categoria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta" ADD CONSTRAINT "venta_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta" ADD CONSTRAINT "venta_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_venta" ADD CONSTRAINT "detalle_venta_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_venta" ADD CONSTRAINT "detalle_venta_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compra" ADD CONSTRAINT "compra_proveedor_id_fkey" FOREIGN KEY ("proveedor_id") REFERENCES "proveedor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_compra" ADD CONSTRAINT "detalle_compra_compra_id_fkey" FOREIGN KEY ("compra_id") REFERENCES "compra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_compra" ADD CONSTRAINT "detalle_compra_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_electronica" ADD CONSTRAINT "factura_electronica_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimiento_stock" ADD CONSTRAINT "movimiento_stock_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
