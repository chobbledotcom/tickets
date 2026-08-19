/* jscpd:ignore-start */
import {
  bytesEqual,
  type DerValue,
  encodeOid,
  readDerChildren,
  readDerSequence,
  requireDerTag,
} from "#crypto/der.ts";
import { readPem } from "#crypto/pem.ts";
import { isValidRsaPublicKey } from "#crypto/rsa-private-key.ts";

/* jscpd:ignore-end */

const RSA_ENCRYPTION_OID = encodeOid("1.2.840.113549.1.1.1");

export interface AppleCertificate {
  bytes: Uint8Array;
  issuer: Uint8Array;
  publicKey: Uint8Array;
  serialNumber: Uint8Array;
}

type CertificateParts = {
  bytes: Uint8Array;
  issuer: DerValue;
  publicKey: DerValue;
  serialNumber: DerValue;
};

const fieldAt = (
  fields: readonly DerValue[],
  index: number,
  tag: number,
  label: string,
): DerValue => {
  const field = fields[index];
  if (field === undefined) throw new Error(`Certificate has no ${label}`);
  return requireDerTag(field, tag, `certificate ${label}`);
};

const requireRsaPublicKey = (publicKey: DerValue): void => {
  // SubjectPublicKeyInfo is an AlgorithmIdentifier followed by the public-key
  // BIT STRING. Web Crypto later validates the key bytes themselves.
  const fields = readDerChildren(publicKey);
  const algorithm = fieldAt(fields, 0, 0x30, "public-key algorithm");
  const algorithmFields = readDerChildren(algorithm);
  const oid = fieldAt(algorithmFields, 0, 0x06, "public-key OID");
  if (!bytesEqual(oid.encoded, RSA_ENCRYPTION_OID)) {
    throw new Error("Certificate public key is not RSA");
  }
  fieldAt(fields, 1, 0x03, "public key");
};

/** Parse the certificate envelope shared by RSA leaf and intermediate certs. */
const readCertificateParts = (pem: string): CertificateParts => {
  const { bytes } = readPem(pem, ["CERTIFICATE", "X509 CERTIFICATE"]);
  // Certificate contains two 0x30 SEQUENCEs followed by the 0x03 signature
  // BIT STRING: TBSCertificate, signatureAlgorithm, and signatureValue.
  const fields = readDerSequence(bytes, "certificate");
  if (fields.length !== 3) throw new Error("Invalid certificate fields");
  const body = fieldAt(fields, 0, 0x30, "body");
  fieldAt(fields, 1, 0x30, "signature algorithm");
  fieldAt(fields, 2, 0x03, "signature");

  const bodyFields = readDerChildren(body);
  // TBSCertificate starts with optional [0] EXPLICIT version; absent means v1.
  // The remaining fixed order is serial, signature, issuer, validity, subject,
  // then SubjectPublicKeyInfo.
  const offset = bodyFields[0]?.tag === 0xa0 ? 1 : 0;
  const serialNumber = fieldAt(bodyFields, offset, 0x02, "serial number");
  fieldAt(bodyFields, offset + 1, 0x30, "signature algorithm");
  const issuer = fieldAt(bodyFields, offset + 2, 0x30, "issuer");
  fieldAt(bodyFields, offset + 3, 0x30, "validity");
  fieldAt(bodyFields, offset + 4, 0x30, "subject");
  const publicKey = fieldAt(bodyFields, offset + 5, 0x30, "public key");
  return { bytes, issuer, publicKey, serialNumber };
};

/** Return one structurally valid X.509 certificate's DER bytes. */
export const readCertificateBytes = (pem: string): Uint8Array =>
  readCertificateParts(pem).bytes;

/** Whether PEM contains one structurally valid X.509 certificate. */
export const isValidCertificate = (pem: string): boolean => {
  try {
    readCertificateParts(pem);
    return true;
  } catch {
    return false;
  }
};

/**
 * Parse the RSA/X.509 fields needed by CMS. This does not validate the
 * certificate signature, dates, usage, chain, or Apple-specific extensions.
 */
export const readAppleCertificate = (pem: string): AppleCertificate => {
  const { bytes, issuer, publicKey, serialNumber } = readCertificateParts(pem);
  requireRsaPublicKey(publicKey);

  return {
    bytes,
    // CMS reuses the full issuer Name and serial INTEGER encodings. Web Crypto
    // likewise imports the complete SubjectPublicKeyInfo encoding.
    issuer: issuer.encoded,
    publicKey: publicKey.encoded,
    serialNumber: serialNumber.encoded,
  };
};

/** Whether the certificate has supported RSA/X.509 fields and an importable key. */
export const isValidAppleCertificate = async (
  pem: string,
): Promise<boolean> => {
  let certificate: AppleCertificate;
  try {
    certificate = readAppleCertificate(pem);
  } catch {
    return false;
  }
  return isValidRsaPublicKey(certificate.publicKey);
};
