const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Probando conexión a la base de datos usando @prisma/client...');
    // Intentar obtener un producto de ejemplo
    const producto = await prisma.producto.findFirst();
    if (producto) {
      console.log('Conexión OK. Ejemplo de producto:');
      console.log(producto);
    } else {
      console.log('Conexión OK pero no se encontraron productos en la tabla `producto`.');
    }
  } catch (err) {
    console.error('Error al conectar o consultar la base de datos:');
    console.error(err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
