const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');

const CERT_PATH = process.env.SIFEN_CERT_PATH || path.join(__dirname, '..', '..', '..', 'certificados', 'sifen.p12');
const CERT_PASSWORD = process.env.SIFEN_CERT_PASS || '';
const SIGN_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const DIGEST_ALG = 'http://www.w3.org/2001/04/xmlenc#sha256';
const C14N_ALG = 'http://www.w3.org/2001/10/xml-exc-c14n#';

let cachedCertificate = null;

function randomId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

class KeyInfoProvider {
  constructor(certificatePem) {
    this.certificatePem = certificatePem;
    this.certificateBody = certificatePem
      .replace('-----BEGIN CERTIFICATE-----', '')
      .replace('-----END CERTIFICATE-----', '')
      .replace(/\s+/g, '');
  }

  getKeyInfo(prefix = 'ds') {
    return `<${prefix}:X509Data><${prefix}:X509Certificate>${this.certificateBody}</${prefix}:X509Certificate></${prefix}:X509Data>`;
  }

  getKey() {
    return this.certificatePem;
  }
}

async function loadCertificate() {
  if (cachedCertificate) {
    return cachedCertificate;
  }

  const fileBuffer = await fs.readFile(CERT_PATH);
  const p12Asn1 = forge.asn1.fromDer(fileBuffer.toString('binary'));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, CERT_PASSWORD);

  let privateKey = null;
  let certificate = null;

  for (const safeContent of p12.safeContents || []) {
    for (const safeBag of safeContent.safeBags || []) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag) {
        privateKey = forge.pki.privateKeyToPem(safeBag.key);
      }
      if (safeBag.type === forge.pki.oids.certBag) {
        certificate = forge.pki.certificateToPem(safeBag.cert);
      }
    }
  }

  if (!privateKey || !certificate) {
    throw new Error('No se pudo extraer la clave privada o el certificado del archivo P12.');
  }

  const certObj = forge.pki.certificateFromPem(certificate);
  const certInfo = {
    serialNumber: certObj.serialNumber,
    subject: certObj.subject.attributes.map((attr) => `${attr.shortName}=${attr.value}`).join(', '),
    issuer: certObj.issuer.attributes.map((attr) => `${attr.shortName}=${attr.value}`).join(', '),
    notBefore: certObj.validity.notBefore,
    notAfter: certObj.validity.notAfter,
    pem: certificate,
    privateKey
  };

  cachedCertificate = certInfo;
  return certInfo;
}

function buildSignedPropertiesXml({ signatureId, signedPropertiesId, certificatePem }) {
  const certBase64 = certificatePem
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace(/\s+/g, '');
  const certDer = Buffer.from(certBase64, 'base64');
  const certDigest = crypto.createHash('sha256').update(certDer).digest('base64');
  const signingTime = new Date().toISOString();

  return `
  <etsi:QualifyingProperties Target="#${signatureId}" xmlns:etsi="http://uri.etsi.org/01903/v1.3.2#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <etsi:SignedProperties Id="${signedPropertiesId}">
      <etsi:SignedSignatureProperties>
        <etsi:SigningTime>${signingTime}</etsi:SigningTime>
        <etsi:SigningCertificate>
          <etsi:Cert>
            <etsi:CertDigest>
              <ds:DigestMethod Algorithm="${DIGEST_ALG}" />
              <ds:DigestValue>${certDigest}</ds:DigestValue>
            </etsi:CertDigest>
            <etsi:IssuerSerial>
              <ds:X509IssuerName></ds:X509IssuerName>
              <ds:X509SerialNumber></ds:X509SerialNumber>
            </etsi:IssuerSerial>
          </etsi:Cert>
        </etsi:SigningCertificate>
      </etsi:SignedSignatureProperties>
      <etsi:SignedDataObjectProperties />
    </etsi:SignedProperties>
  </etsi:QualifyingProperties>
  `;
}

function injectIssuerData(xmlString, certificatePem) {
  const doc = new DOMParser().parseFromString(xmlString);
  const issuerNodes = doc.getElementsByTagName('ds:X509IssuerName');
  const serialNodes = doc.getElementsByTagName('ds:X509SerialNumber');
  if (issuerNodes.length && serialNodes.length) {
    const certObj = forge.pki.certificateFromPem(certificatePem);
    issuerNodes.item(0).textContent = certObj.issuer.attributes.map((attr) => `${attr.shortName}=${attr.value}`).join(', ');
    serialNodes.item(0).textContent = parseInt(certObj.serialNumber, 16);
  }
  return doc.toString();
}

async function signXml(xmlString, { referenceXPath = "//*[local-name()='DE']" } = {}) {
  const certInfo = await loadCertificate();
  const signatureId = randomId('Signature');
  const signedPropertiesId = randomId('SignedProperties');
  const signedPropertiesXml = buildSignedPropertiesXml({
    signatureId,
    signedPropertiesId,
    certificatePem: certInfo.pem
  });

  const signedXml = new SignedXml();
  signedXml.signatureAlgorithm = SIGN_ALG;
  signedXml.canonicalizationAlgorithm = C14N_ALG;
  signedXml.addReference(referenceXPath, ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N_ALG], DIGEST_ALG);
  signedXml.addReference(`#${signedPropertiesId}`, [C14N_ALG], DIGEST_ALG, '', '', '', true);
  signedXml.addObject({
    id: randomId('QualifyingProperties'),
    mimeType: 'text/xml',
    encoding: 'utf8',
    data: signedPropertiesXml
  });
  signedXml.signingKey = certInfo.privateKey;
  signedXml.keyInfoProvider = new KeyInfoProvider(certInfo.pem);
  signedXml.signatureId = signatureId;

  const signedDocument = signedXml.computeSignature(xmlString, {
    prefix: 'ds',
    location: { reference: referenceXPath, action: 'append' }
  });

  const enriched = injectIssuerData(signedDocument, certInfo.pem);

  return {
    xml: enriched,
    signatureId,
    signedPropertiesId,
    certificate: {
      serialNumber: certInfo.serialNumber,
      subject: certInfo.subject,
      issuer: certInfo.issuer,
      notBefore: certInfo.notBefore,
      notAfter: certInfo.notAfter
    }
  };
}

module.exports = {
  signXml,
  loadCertificate
};
