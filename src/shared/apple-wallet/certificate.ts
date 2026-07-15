/* jscpd:ignore-start */
import {
  bytesEqual,
  type DerValue,
  encodeOid,
  readDerChildren,
  readDerSequence,
  requireDerTag,
} from "#shared/crypto/der.ts";
import { readPem } from "#shared/crypto/pem.ts";

/* jscpd:ignore-end */

const RSA_ENCRYPTION_OID = encodeOid("1.2.840.113549.1.1.1");

export interface AppleCertificate {
  bytes: Uint8Array;
  issuer: Uint8Array;
  publicKey: Uint8Array;
  serialNumber: Uint8Array;
}

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
  const fields = readDerChildren(publicKey);
  const algorithm = fieldAt(fields, 0, 0x30, "public-key algorithm");
  const algorithmFields = readDerChildren(algorithm);
  const oid = fieldAt(algorithmFields, 0, 0x06, "public-key OID");
  if (!bytesEqual(oid.encoded, RSA_ENCRYPTION_OID)) {
    throw new Error("Certificate public key is not RSA");
  }
  fieldAt(fields, 1, 0x03, "public key");
};

/** Extract the exact issuer, serial, and public key DER needed by CMS. */
export const readAppleCertificate = (pem: string): AppleCertificate => {
  const { bytes } = readPem(pem, ["CERTIFICATE", "X509 CERTIFICATE"]);
  const certificateFields = readDerSequence(bytes, "certificate");
  if (certificateFields.length !== 3)
    throw new Error("Invalid certificate fields");
  const tbs = fieldAt(certificateFields, 0, 0x30, "body");
  fieldAt(certificateFields, 1, 0x30, "signature algorithm");
  fieldAt(certificateFields, 2, 0x03, "signature");

  const fields = readDerChildren(tbs);
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0;
  const serialNumber = fieldAt(fields, offset, 0x02, "serial number");
  fieldAt(fields, offset + 1, 0x30, "signature algorithm");
  const issuer = fieldAt(fields, offset + 2, 0x30, "issuer");
  fieldAt(fields, offset + 3, 0x30, "validity");
  fieldAt(fields, offset + 4, 0x30, "subject");
  const publicKey = fieldAt(fields, offset + 5, 0x30, "public key");
  requireRsaPublicKey(publicKey);

  return {
    bytes,
    issuer: issuer.encoded,
    publicKey: publicKey.encoded,
    serialNumber: serialNumber.encoded,
  };
};

export const isValidAppleCertificate = (pem: string): boolean => {
  try {
    readAppleCertificate(pem);
    return true;
  } catch {
    return false;
  }
};
