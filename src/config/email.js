const numberOrUndefined = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const config = {
  from: process.env.EMAIL_FROM || 'facturacion@tridentinnova.com',
  host: process.env.SMTP_HOST,
  port: numberOrUndefined(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
  replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM,
  baseDownloadUrl: process.env.FACTURA_DIGITAL_BASE_URL || process.env.PUBLIC_BASE_URL || '',
  enabled: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
};

module.exports = config;
