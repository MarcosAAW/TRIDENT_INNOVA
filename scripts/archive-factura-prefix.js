require('dotenv').config();

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function parseArgs(argv) {
  const args = {
    from: '001-001',
    to: '901-001',
    apply: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--from' && argv[index + 1]) {
      args.from = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--to' && argv[index + 1]) {
      args.to = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--apply') {
      args.apply = true;
    }
  }

  return args;
}

function validatePrefix(value, label) {
  if (!/^\d{3}-\d{3}$/.test(value)) {
    throw new Error(`${label} debe tener formato 000-000`);
  }
}

function splitPrefix(prefix) {
  const [establecimiento, punto] = prefix.split('-');
  return { establecimiento, punto };
}

function replacePrefix(numero, fromPrefix, toPrefix) {
  const match = String(numero || '').match(/^(\d{3}-\d{3})-(\d+)$/);
  if (!match) return numero;
  if (match[1] !== fromPrefix) return numero;
  return `${toPrefix}-${match[2]}`;
}

function parseSequence(numero) {
  const match = String(numero || '').match(/^\d{3}-\d{3}-(\d+)$/);
  return match ? Number(match[1]) || 0 : 0;
}

async function collectDocs(fromPrefix, targetPrefix) {
  const { establecimiento: fromEst, punto: fromPunto } = splitPrefix(fromPrefix);
  const { establecimiento: toEst, punto: toPunto } = splitPrefix(targetPrefix);

  const [facturasElectronicas, facturasDigitales, notasCredito, collisions] = await Promise.all([
    prisma.facturaElectronica.findMany({
      where: { nro_factura: { startsWith: `${fromPrefix}-` } },
      select: { id: true, ventaId: true, nro_factura: true },
      orderBy: { nro_factura: 'asc' }
    }),
    prisma.facturaDigital.findMany({
      where: { establecimiento: fromEst, punto_expedicion: fromPunto },
      select: { id: true, ventaId: true, nro_factura: true, secuencia: true, timbrado: true },
      orderBy: { secuencia: 'asc' }
    }),
    prisma.notaCreditoElectronica.findMany({
      where: {
        OR: [
          { nro_nota: { startsWith: `${fromPrefix}-` } },
          { establecimiento: fromEst, punto_expedicion: fromPunto }
        ]
      },
      select: { id: true, ventaId: true, facturaElectronicaId: true, nro_nota: true, secuencia: true },
      orderBy: { secuencia: 'asc' }
    }),
    Promise.all([
      prisma.facturaElectronica.count({ where: { nro_factura: { startsWith: `${targetPrefix}-` } } }),
      prisma.facturaDigital.count({ where: { establecimiento: toEst, punto_expedicion: toPunto } }),
      prisma.notaCreditoElectronica.count({
        where: {
          OR: [
            { nro_nota: { startsWith: `${targetPrefix}-` } },
            { establecimiento: toEst, punto_expedicion: toPunto }
          ]
        }
      })
    ])
  ]);

  return {
    facturasElectronicas,
    facturasDigitales,
    notasCredito,
    collisions: {
      facturasElectronicas: collisions[0],
      facturasDigitales: collisions[1],
      notasCredito: collisions[2]
    }
  };
}

async function computeNextFactura(fromPrefix) {
  const { establecimiento, punto } = splitPrefix(fromPrefix);

  const [electronicas, digital] = await Promise.all([
    prisma.facturaElectronica.findMany({
      where: { nro_factura: { startsWith: `${fromPrefix}-` } },
      select: { nro_factura: true },
      orderBy: { created_at: 'desc' },
      take: 50
    }),
    prisma.facturaDigital.findFirst({
      where: { establecimiento, punto_expedicion: punto },
      select: { secuencia: true },
      orderBy: { secuencia: 'desc' }
    })
  ]);

  const maxElectronica = electronicas.reduce((max, item) => Math.max(max, parseSequence(item.nro_factura)), 0);
  const maxDigital = Number(digital?.secuencia) || 0;

  return Math.max(maxElectronica, maxDigital) + 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validatePrefix(args.from, 'from');
  validatePrefix(args.to, 'to');

  if (args.from === args.to) {
    throw new Error('from y to no pueden ser iguales');
  }

  const { establecimiento: toEst, punto: toPunto } = splitPrefix(args.to);
  const docs = await collectDocs(args.from, args.to);

  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    from: args.from,
    to: args.to,
    counts: {
      facturasElectronicas: docs.facturasElectronicas.length,
      facturasDigitales: docs.facturasDigitales.length,
      notasCredito: docs.notasCredito.length
    },
    collisions: docs.collisions,
    sample: {
      facturasElectronicas: docs.facturasElectronicas.slice(0, 5).map((item) => item.nro_factura),
      facturasDigitales: docs.facturasDigitales.slice(0, 5).map((item) => item.nro_factura),
      notasCredito: docs.notasCredito.slice(0, 5).map((item) => item.nro_nota)
    }
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!args.apply) {
    const next = await computeNextFactura(args.from);
    console.log(`next_${args.from}=${next}`);
    return;
  }

  if (docs.collisions.facturasElectronicas || docs.collisions.facturasDigitales || docs.collisions.notasCredito) {
    throw new Error(`El prefijo destino ${args.to} ya tiene documentos; abortando para evitar colisiones.`);
  }

  const updates = [];

  for (const item of docs.facturasElectronicas) {
    updates.push(
      prisma.facturaElectronica.update({
        where: { id: item.id },
        data: { nro_factura: replacePrefix(item.nro_factura, args.from, args.to) }
      })
    );
  }

  for (const item of docs.facturasDigitales) {
    updates.push(
      prisma.facturaDigital.update({
        where: { id: item.id },
        data: {
          nro_factura: replacePrefix(item.nro_factura, args.from, args.to),
          establecimiento: toEst,
          punto_expedicion: toPunto
        }
      })
    );
  }

  for (const item of docs.notasCredito) {
    updates.push(
      prisma.notaCreditoElectronica.update({
        where: { id: item.id },
        data: {
          nro_nota: replacePrefix(item.nro_nota, args.from, args.to),
          establecimiento: toEst,
          punto_expedicion: toPunto
        }
      })
    );
  }

  if (updates.length) {
    await prisma.$transaction(updates);
  }

  const next = await computeNextFactura(args.from);
  console.log(`next_${args.from}=${next}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });