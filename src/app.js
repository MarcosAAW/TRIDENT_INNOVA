require('dotenv').config();
const path = require('path');
const express = require('express');
const morgan = require('morgan');
const prisma = require('./prismaClient');

const productoRoutes = require('./routes/producto');
const ventaRoutes = require('./routes/venta');
const clienteRoutes = require('./routes/cliente');
const usuarioRoutes = require('./routes/usuario');
const authRoutes = require('./routes/auth');
const cierreCajaRoutes = require('./routes/cierreCaja');
const salidaCajaRoutes = require('./routes/salidaCaja');
const facturaDigitalRoutes = require('./routes/facturaDigital');
const factpyRoutes = require('./routes/factpy');
const pagoRoutes = require('./routes/pago');
const reciboRoutes = require('./routes/recibo');
const sucursalRoutes = require('./routes/sucursal');
const presupuestoRoutes = require('./routes/presupuesto');
const proveedorRoutes = require('./routes/proveedor');
const notaPedidoRoutes = require('./routes/notaPedido');
const errorHandler = require('./middleware/errorHandler');
const { attachUser } = require('./middleware/authContext');

const app = express();
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/storage', express.static(path.join(__dirname, '..', 'storage')));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'Trident Innova API' }));

app.use(attachUser);

app.use('/productos', productoRoutes);
app.use('/ventas', ventaRoutes);
app.use('/clientes', clienteRoutes);
app.use('/usuarios', usuarioRoutes);
app.use('/auth', authRoutes);
app.use('/cierres-caja', cierreCajaRoutes);
app.use('/salidas-caja', salidaCajaRoutes);
if (shouldMountLegacyFacturaDigitalRoutes()) {
	app.use('/facturas-digitales', facturaDigitalRoutes);
}
app.use('/pagos', pagoRoutes);
app.use('/recibos', reciboRoutes);
app.use('/factpy', factpyRoutes);
app.use('/sucursales', sucursalRoutes);
app.use('/presupuestos', presupuestoRoutes);
app.use('/proveedores', proveedorRoutes);
app.use('/notas-pedido', notaPedidoRoutes);

// Error handler (último middleware)
app.use(errorHandler);

function shouldMountLegacyFacturaDigitalRoutes() {
	const configured = process.env.FACTURA_DIGITAL_LEGACY_ENABLED;
	if (configured !== undefined) {
		return !['false', '0', 'off', 'no'].includes(String(configured).trim().toLowerCase());
	}

	return process.env.NODE_ENV !== 'production';
}

module.exports = { app, prisma };
