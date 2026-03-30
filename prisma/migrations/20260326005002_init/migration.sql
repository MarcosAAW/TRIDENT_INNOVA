-- CreateEnum
CREATE TYPE "TipoProducto" AS ENUM ('DRON', 'REPUESTO', 'SERVICIO', 'OTRO');

-- CreateEnum
CREATE TYPE "RolUsuario" AS ENUM ('ADMIN', 'VENDEDOR', 'TECNICO', 'GERENCIA');

-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('ENTRADA', 'SALIDA');

-- CreateEnum
CREATE TYPE "EstadoFactura" AS ENUM ('PENDIENTE', 'ENVIADO', 'ACEPTADO', 'PAGADA', 'RECHAZADO');

-- CreateTable
CREATE TABLE "producto" (
    "id" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "tipo" "TipoProducto" NOT NULL,
    "precio_venta" DECIMAL(12,2) NOT NULL,
    "precio_venta_original" DECIMAL(12,2),
    "moneda_precio_venta" TEXT NOT NULL DEFAULT 'PYG',
    "tipo_cambio_precio_venta" DECIMAL(12,4),
    "precio_compra" DECIMAL(12,2),
    "precio_compra_original" DECIMAL(12,2),
    "moneda_precio_compra" TEXT DEFAULT 'PYG',
    "tipo_cambio_precio_compra" DECIMAL(12,4),
    "stock_actual" INTEGER NOT NULL DEFAULT 0,
    "codigo_dji" TEXT,
    "codigo_barra" TEXT,
    "categoria_id" UUID,
    "minimo_stock" INTEGER,
    "unidad" TEXT,
    "imagen_url" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "sucursal_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "producto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "presupuesto" (
    "id" UUID NOT NULL,
    "numero" TEXT NOT NULL,
    "cliente_id" UUID,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validez_hasta" TIMESTAMP(3),
    "moneda" TEXT NOT NULL DEFAULT 'PYG',
    "tipo_cambio" DECIMAL(12,4),
    "subtotal" DECIMAL(12,2) NOT NULL,
    "descuento_total" DECIMAL(12,2),
    "impuesto_total" DECIMAL(12,2),
    "total" DECIMAL(12,2) NOT NULL,
    "total_moneda" DECIMAL(12,2),
    "estado" TEXT NOT NULL DEFAULT 'BORRADOR',
    "notas" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "presupuesto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detalle_presupuesto" (
    "id" UUID NOT NULL,
    "presupuesto_id" UUID NOT NULL,
    "producto_id" UUID,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "iva_porcentaje" INTEGER NOT NULL DEFAULT 10,

    CONSTRAINT "detalle_presupuesto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categoria" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "categoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cliente" (
    "id" UUID NOT NULL,
    "nombre_razon_social" TEXT NOT NULL,
    "ruc" TEXT,
    "direccion" TEXT,
    "telefono" TEXT,
    "correo" TEXT,
    "tipo_cliente" TEXT,
    "sucursal_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proveedor" (
    "id" UUID NOT NULL,
    "nombre_razon_social" TEXT NOT NULL,
    "ruc" TEXT,
    "contacto" TEXT,
    "direccion" TEXT,
    "telefono" TEXT,
    "correo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "usuario" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "rol" "RolUsuario" NOT NULL DEFAULT 'ADMIN',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "last_login" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sucursal" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "ciudad" TEXT,
    "direccion" TEXT,
    "telefono" TEXT,
    "establecimiento" TEXT,
    "punto_expedicion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "sucursal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usuario_sucursal" (
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID NOT NULL,
    "rol" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_sucursal_pkey" PRIMARY KEY ("usuario_id","sucursal_id")
);

-- CreateTable
CREATE TABLE "venta" (
    "id" UUID NOT NULL,
    "cliente_id" UUID,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "descuento_total" DECIMAL(12,2),
    "impuesto_total" DECIMAL(12,2),
    "total" DECIMAL(12,2) NOT NULL,
    "total_moneda" DECIMAL(12,2),
    "iva_porcentaje" INTEGER NOT NULL DEFAULT 10,
    "estado" TEXT NOT NULL,
    "factura_electronica_id" TEXT,
    "moneda" TEXT DEFAULT 'PYG',
    "tipo_cambio" DECIMAL(12,4),
    "condicion_venta" TEXT NOT NULL DEFAULT 'CONTADO',
    "es_credito" BOOLEAN NOT NULL DEFAULT false,
    "fecha_vencimiento" TIMESTAMP(3),
    "saldo_pendiente" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detalle_venta" (
    "id" UUID NOT NULL,
    "venta_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "detalle_venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compra" (
    "id" UUID NOT NULL,
    "proveedor_id" UUID,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "estado" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detalle_compra" (
    "id" UUID NOT NULL,
    "compra_id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "precio_unitario" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "detalle_compra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factura_electronica" (
    "id" UUID NOT NULL,
    "venta_id" UUID,
    "sucursal_id" UUID,
    "nro_factura" TEXT,
    "timbrado" TEXT,
    "fecha_emision" TIMESTAMP(3),
    "xml_path" TEXT,
    "pdf_path" TEXT,
    "qr_data" TEXT,
    "estado" "EstadoFactura" NOT NULL DEFAULT 'PENDIENTE',
    "respuesta_set" JSONB,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "ambiente" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "factura_electronica_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "factura_digital" (
    "id" UUID NOT NULL,
    "venta_id" UUID,
    "sucursal_id" UUID,
    "nro_factura" TEXT NOT NULL,
    "timbrado" TEXT NOT NULL,
    "establecimiento" TEXT NOT NULL,
    "punto_expedicion" TEXT NOT NULL,
    "secuencia" INTEGER NOT NULL,
    "condicion_venta" TEXT NOT NULL DEFAULT 'CONTADO',
    "fecha_emision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moneda" TEXT NOT NULL DEFAULT 'PYG',
    "total_exentas" DECIMAL(12,2),
    "total_gravada_5" DECIMAL(12,2),
    "total_gravada_10" DECIMAL(12,2),
    "total_iva_5" DECIMAL(12,2),
    "total_iva_10" DECIMAL(12,2),
    "total" DECIMAL(12,2) NOT NULL,
    "total_iva" DECIMAL(12,2),
    "total_letras" TEXT,
    "pdf_path" TEXT,
    "hash_pdf" TEXT,
    "qr_data" TEXT,
    "numero_control" TEXT,
    "estado_envio" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "enviado_a" TEXT,
    "enviado_en" TIMESTAMP(3),
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "factura_digital_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimiento_stock" (
    "id" UUID NOT NULL,
    "producto_id" UUID NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "cantidad" INTEGER NOT NULL,
    "motivo" TEXT,
    "referencia_id" TEXT,
    "referencia_tipo" TEXT,
    "almacen_id" TEXT,
    "usuario_id" UUID,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movimiento_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pago" (
    "id" UUID NOT NULL,
    "venta_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "fecha_pago" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodo" TEXT NOT NULL,
    "referencia" TEXT,

    CONSTRAINT "pago_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cierre_caja" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "apertura_id" UUID,
    "sucursal_id" UUID,
    "saldo_inicial" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fecha_apertura" TIMESTAMP(3),
    "fecha_cierre" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_ventas" DECIMAL(12,2) NOT NULL,
    "total_ventas_usd" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_efectivo" DECIMAL(12,2) NOT NULL,
    "efectivo_usd" DECIMAL(12,2),
    "total_tarjeta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_transferencia" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_salidas" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "efectivo_declarado" DECIMAL(12,2),
    "diferencia" DECIMAL(12,2),
    "observaciones" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "cierre_caja_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "salida_caja" (
    "id" UUID NOT NULL,
    "cierre_id" UUID,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "descripcion" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "salida_caja_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apertura_caja" (
    "id" UUID NOT NULL,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "fecha_apertura" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_cierre" TIMESTAMP(3),
    "saldo_inicial" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "observaciones" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "apertura_caja_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "archivo" (
    "id" UUID NOT NULL,
    "tipo_entidad" TEXT NOT NULL,
    "entidad_id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "ruta" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "subido_por" TEXT,
    "subido_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificado" (
    "id" UUID NOT NULL,
    "huella" TEXT NOT NULL,
    "ruta_cifrada" TEXT NOT NULL,
    "valido_desde" TIMESTAMP(3),
    "valido_hasta" TIMESTAMP(3),
    "ambiente" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "almacen" (
    "id" UUID NOT NULL,
    "nombre" TEXT NOT NULL,
    "direccion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "almacen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recibo" (
    "id" UUID NOT NULL,
    "numero" TEXT,
    "cliente_id" UUID,
    "usuario_id" UUID NOT NULL,
    "sucursal_id" UUID,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total" DECIMAL(12,2) NOT NULL,
    "total_moneda" DECIMAL(12,2),
    "moneda" TEXT NOT NULL DEFAULT 'PYG',
    "tipo_cambio" DECIMAL(12,4),
    "metodo" TEXT NOT NULL,
    "referencia" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "observacion" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recibo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recibo_detalle" (
    "id" UUID NOT NULL,
    "recibo_id" UUID NOT NULL,
    "venta_id" UUID NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "monto_moneda" DECIMAL(12,2),
    "saldo_previo" DECIMAL(12,2),
    "saldo_posterior" DECIMAL(12,2),

    CONSTRAINT "recibo_detalle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "usuario_id" UUID,
    "accion" TEXT NOT NULL,
    "tabla" TEXT NOT NULL,
    "registro_id" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "producto_sku_key" ON "producto"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "producto_codigo_barra_key" ON "producto"("codigo_barra");

-- CreateIndex
CREATE UNIQUE INDEX "presupuesto_numero_sucursal_id_key" ON "presupuesto"("numero", "sucursal_id");

-- CreateIndex
CREATE UNIQUE INDEX "cliente_ruc_key" ON "cliente"("ruc");

-- CreateIndex
CREATE UNIQUE INDEX "proveedor_ruc_key" ON "proveedor"("ruc");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_usuario_key" ON "usuario"("usuario");

-- CreateIndex
CREATE UNIQUE INDEX "factura_electronica_venta_id_key" ON "factura_electronica"("venta_id");

-- CreateIndex
CREATE UNIQUE INDEX "factura_electronica_nro_factura_key" ON "factura_electronica"("nro_factura");

-- CreateIndex
CREATE UNIQUE INDEX "factura_digital_venta_id_key" ON "factura_digital"("venta_id");

-- CreateIndex
CREATE UNIQUE INDEX "factura_digital_nro_factura_key" ON "factura_digital"("nro_factura");

-- CreateIndex
CREATE UNIQUE INDEX "factura_digital_timbrado_establecimiento_punto_expedicion_s_key" ON "factura_digital"("timbrado", "establecimiento", "punto_expedicion", "secuencia");

-- CreateIndex
CREATE UNIQUE INDEX "cierre_caja_apertura_id_key" ON "cierre_caja"("apertura_id");

-- CreateIndex
CREATE UNIQUE INDEX "certificado_huella_key" ON "certificado"("huella");

-- CreateIndex
CREATE UNIQUE INDEX "recibo_numero_key" ON "recibo"("numero");

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_categoria_id_fkey" FOREIGN KEY ("categoria_id") REFERENCES "categoria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "producto" ADD CONSTRAINT "producto_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presupuesto" ADD CONSTRAINT "presupuesto_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presupuesto" ADD CONSTRAINT "presupuesto_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "presupuesto" ADD CONSTRAINT "presupuesto_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_presupuesto" ADD CONSTRAINT "detalle_presupuesto_presupuesto_id_fkey" FOREIGN KEY ("presupuesto_id") REFERENCES "presupuesto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detalle_presupuesto" ADD CONSTRAINT "detalle_presupuesto_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cliente" ADD CONSTRAINT "cliente_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_sucursal" ADD CONSTRAINT "usuario_sucursal_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usuario_sucursal" ADD CONSTRAINT "usuario_sucursal_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta" ADD CONSTRAINT "venta_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta" ADD CONSTRAINT "venta_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venta" ADD CONSTRAINT "venta_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "factura_electronica" ADD CONSTRAINT "factura_electronica_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_digital" ADD CONSTRAINT "factura_digital_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "factura_digital" ADD CONSTRAINT "factura_digital_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movimiento_stock" ADD CONSTRAINT "movimiento_stock_producto_id_fkey" FOREIGN KEY ("producto_id") REFERENCES "producto"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pago" ADD CONSTRAINT "pago_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_apertura_id_fkey" FOREIGN KEY ("apertura_id") REFERENCES "apertura_caja"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cierre_caja" ADD CONSTRAINT "cierre_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_cierre_id_fkey" FOREIGN KEY ("cierre_id") REFERENCES "cierre_caja"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salida_caja" ADD CONSTRAINT "salida_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apertura_caja" ADD CONSTRAINT "apertura_caja_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "apertura_caja" ADD CONSTRAINT "apertura_caja_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "cliente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo" ADD CONSTRAINT "recibo_sucursal_id_fkey" FOREIGN KEY ("sucursal_id") REFERENCES "sucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo_detalle" ADD CONSTRAINT "recibo_detalle_recibo_id_fkey" FOREIGN KEY ("recibo_id") REFERENCES "recibo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recibo_detalle" ADD CONSTRAINT "recibo_detalle_venta_id_fkey" FOREIGN KEY ("venta_id") REFERENCES "venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
