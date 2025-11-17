const { app, prisma } = require('./app');

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`API escuchando en http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Cerrando servidor y desconectando Prisma...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled Rejection:', reason);
  try { await prisma.$disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});

process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  try { await prisma.$disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});
