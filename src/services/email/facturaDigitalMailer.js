const path = require('path');
const fs = require('fs/promises');
const nodemailer = require('nodemailer');
const prisma = require('../../prismaClient');
const emailConfig = require('../../config/email');
const empresaConfig = require('../../config/empresa');

const ROOT_DIR = path.join(__dirname, '..', '..', '..');

class EmailNotConfiguredError extends Error {
  constructor(message = 'El servidor de correo no está configurado.') {
    super(message);
    this.name = 'EmailNotConfiguredError';
    this.code = 'EMAIL_NO_CONFIGURADO';
  }
}

class DestinatarioInvalidoError extends Error {
  constructor(message = 'No se encontró un destinatario para la factura digital.') {
    super(message);
    this.name = 'DestinatarioInvalidoError';
    this.code = 'DESTINATARIO_NO_DISPONIBLE';
  }
}

let transporter;

function getTransporter() {
  if (!emailConfig.enabled) {
    return null;
  }
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.secure,
    auth: {
      user: emailConfig.user,
      pass: emailConfig.pass
    }
  });
  return transporter;
}

function resolvePdfAbsolutePath(webPath) {
  if (!webPath) return null;
  const relative = webPath.replace(/^\/+/, '');
  return path.join(ROOT_DIR, relative);
}

async function ensureFileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch (_err) {
    return false;
  }
}

function buildDownloadLink(facturaId) {
  if (!emailConfig.baseDownloadUrl) return null;
  const base = emailConfig.baseDownloadUrl.endsWith('/')
    ? emailConfig.baseDownloadUrl.slice(0, -1)
    : emailConfig.baseDownloadUrl;
  return `${base}/facturas-digitales/${facturaId}/pdf`;
}

function buildCorreoTexto({ factura, venta, downloadLink }) {
  const lineas = [
    `Estimado/a ${venta?.cliente?.nombre_razon_social || 'cliente'},`,
    '',
    `Adjuntamos la factura digital Nº ${factura.nro_factura} emitida por ${empresaConfig.nombre}.`,
    `Total a pagar: Gs. ${Number(factura.total || venta?.total || 0).toLocaleString('es-PY')}.`,
    ''
  ];
  if (downloadLink) {
    lineas.push(`También puede descargarla desde: ${downloadLink}`, '');
  }
  lineas.push('Por favor conserve este documento para fines tributarios.', '', 'Atentamente,', empresaConfig.nombre);
  return lineas.join('\n');
}

async function enviarFacturaDigitalPorCorreo(factura, venta, options = {}) {
  if (!factura?.pdf_path) {
    throw new Error('La factura digital aún no tiene PDF disponible.');
  }
  const destinatario = options.destinatario || venta?.cliente?.correo || factura.enviado_a;
  if (!destinatario) {
    throw new DestinatarioInvalidoError();
  }

  const transport = getTransporter();
  if (!transport) {
    throw new EmailNotConfiguredError();
  }

  const pdfAbsolutePath = resolvePdfAbsolutePath(factura.pdf_path);
  const fileExists = await ensureFileExists(pdfAbsolutePath);
  if (!fileExists) {
    throw new Error('No se encontró el archivo PDF para adjuntar.');
  }

  const downloadLink = buildDownloadLink(factura.id);
  const mailOptions = {
    from: emailConfig.from,
    to: destinatario,
    replyTo: emailConfig.replyTo,
    subject: `Factura Nº ${factura.nro_factura} - ${empresaConfig.nombre}`,
    text: buildCorreoTexto({ factura, venta, downloadLink }),
    attachments: [
      {
        filename: `${factura.nro_factura}.pdf`,
        path: pdfAbsolutePath,
        contentType: 'application/pdf'
      }
    ]
  };

  try {
    await transport.sendMail(mailOptions);
    const updated = await prisma.facturaDigital.update({
      where: { id: factura.id },
      data: {
        estado_envio: 'ENVIADO',
        enviado_a: destinatario,
        enviado_en: new Date(),
        intentos: { increment: 1 }
      }
    });
    return updated;
  } catch (err) {
    await prisma.facturaDigital.update({
      where: { id: factura.id },
      data: {
        estado_envio: 'ERROR',
        intentos: { increment: 1 }
      }
    });
    throw err;
  }
}

module.exports = {
  enviarFacturaDigitalPorCorreo,
  EmailNotConfiguredError,
  DestinatarioInvalidoError,
  isEmailEnabled: () => Boolean(emailConfig.enabled)
};
