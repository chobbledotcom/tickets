import {
  bytesEqual,
  encodeDer,
  encodeInteger,
  encodeNull,
  encodeOid,
  encodeSequence,
  readDerSequence,
  requireDerTag,
} from "#shared/crypto/der.ts";
import { readPem } from "#shared/crypto/pem.ts";

const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";
const RSA_PRIVATE_KEY_FIELDS = 9;

const requireRsaAlgorithm = (algorithm: Uint8Array): void => {
  const fields = readDerSequence(algorithm, "RSA algorithm");
  if (
    !fields[0] ||
    !bytesEqual(fields[0].encoded, encodeOid(RSA_ENCRYPTION_OID))
  ) {
    throw new Error("Private key is not RSA");
  }
};

const requirePkcs1 = (bytes: Uint8Array): void => {
  const fields = readDerSequence(bytes, "RSA private key");
  if (fields.length < RSA_PRIVATE_KEY_FIELDS)
    throw new Error("Incomplete RSA private key");
  for (const field of fields.slice(0, RSA_PRIVATE_KEY_FIELDS)) {
    requireDerTag(field, 0x02, "RSA private key field");
  }
  const version = fields[0]!.contents;
  if (version.length !== 1 || (version[0] !== 0 && version[0] !== 1)) {
    throw new Error("Unsupported RSA private key version");
  }
};

const wrapPkcs1 = (bytes: Uint8Array): Uint8Array =>
  encodeSequence([
    encodeInteger(0),
    encodeSequence([encodeOid(RSA_ENCRYPTION_OID), encodeNull()]),
    encodeDer(0x04, [bytes]),
  ]);

const requirePkcs8 = (bytes: Uint8Array): void => {
  const fields = readDerSequence(bytes, "private key");
  if (fields.length < 3) throw new Error("Incomplete private key");
  requireDerTag(fields[0]!, 0x02, "private key version");
  requireRsaAlgorithm(fields[1]!.encoded);
  requirePkcs1(requireDerTag(fields[2]!, 0x04, "private key bytes").contents);
};

/** Return an unencrypted RSA private key as PKCS#8 bytes for Web Crypto. */
export const rsaPrivateKeyBytes = (pem: string): Uint8Array => {
  const decoded = readPem(pem, ["PRIVATE KEY", "RSA PRIVATE KEY"]);
  if (decoded.label === "RSA PRIVATE KEY") {
    requirePkcs1(decoded.bytes);
    return wrapPkcs1(decoded.bytes);
  }
  requirePkcs8(decoded.bytes);
  return decoded.bytes;
};

export const isValidRsaPrivateKey = (pem: string): boolean => {
  try {
    rsaPrivateKeyBytes(pem);
    return true;
  } catch {
    return false;
  }
};
