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
app.use('/facturas-digitales', facturaDigitalRoutes);

// Error handler (último middleware)
app.use(errorHandler);

module.exports = { app, prisma };
