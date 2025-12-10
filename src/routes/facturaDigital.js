const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { z } = require('zod');
const prisma = require('../prismaClient');
const { serialize } = require('../utils/serialize');
const {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  DestinatarioInvalidoError
} = require('../services/email/facturaDigitalMailer');

const router = express.Router();
const ROOT_DIR = path.join(__dirname, '..', '..');

const resendSchema = z.object({
  destinatario: z
    .string()
    .email('Correo inválido')
    .optional()
});

router.get('/:id/pdf', async (req, res) => {
  const { id } = req.params;
  try {
    const factura = await prisma.facturaDigital.findUnique({ where: { id } });
    if (!factura || !factura.pdf_path) {
      return res.status(404).json({ error: 'Factura digital no encontrada.' });
    }
    const absolutePath = resolveAbsoluteFromWeb(factura.pdf_path);
    try {
      await fs.access(absolutePath);
    } catch (_err) {
      return res.status(404).json({ error: 'El archivo PDF ya no está disponible.' });
    }
    return res.sendFile(absolutePath);
  } catch (err) {
    console.error('[FacturaDigital] Error al descargar PDF.', err);
    return res.status(500).json({ error: 'No se pudo descargar la factura digital.' });
  }
});

router.post('/:id/enviar', async (req, res) => {
  const { id } = req.params;
  const parsed = resendSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: parsed.error.flatten() });
  }

  try {
    const factura = await prisma.facturaDigital.findUnique({
      where: { id },
      include: {
        venta: {
          include: {
            cliente: true
          }
        }
      }
    });

    if (!factura) {
      return res.status(404).json({ error: 'Factura digital no encontrada.' });
    }

    if (!factura.pdf_path) {
      return res.status(409).json({ error: 'La factura no tiene un PDF generado todavía.' });
    }

    const updated = await enviarFacturaDigitalPorCorreo(factura, factura.venta, {
      destinatario: parsed.data.destinatario
    });

    return res.json({
      message: 'Factura enviada correctamente.',
      factura: serialize(updated)
    });
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return res.status(412).json({ error: err.message, code: err.code });
    }
    if (err instanceof DestinatarioInvalidoError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('[FacturaDigital] Error al reenviar la factura.', err);
    return res.status(500).json({ error: 'No se pudo reenviar la factura digital.' });
  }
});

function resolveAbsoluteFromWeb(webPath) {
  const normalized = webPath.replace(/^\/+/, '');
  return path.join(ROOT_DIR, normalized);
}

module.exports = router;
