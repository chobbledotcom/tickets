import {
  bytesEqual,
  encodeDer,
  encodeInteger,
  encodeNull,
  encodeOid,
  encodeSequence,
  readDerSequence,
  requireDerTag,
} from "#crypto/der.ts";
import { readPem } from "#crypto/pem.ts";

// PKCS #1 rsaEncryption. PKCS #8 requires this OID followed by DER NULL.
const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";
// PKCS #1 v0 has version, n, e, d, p, q, dP, dQ, and qInv. Version 1 adds
// unsupported multi-prime data after these nine INTEGERs.
const RSA_PRIVATE_KEY_FIELDS = 9;
const RSA_ALGORITHM = encodeSequence([
  encodeOid(RSA_ENCRYPTION_OID),
  encodeNull(),
]);
const RSA_SHA256: RsaHashedImportParams = {
  hash: "SHA-256",
  name: "RSASSA-PKCS1-v1_5",
};
// Apple and Google issue 2048-bit or larger signing keys. Checking before a
// test signature also avoids a Deno 2.5 crash on an RSA modulus too short to
// hold the SHA-256 PKCS #1 signature block.
const MIN_RSA_MODULUS_BITS = 2048;

class InvalidRsaKeySizeError extends Error {}

const importRsaKey = async (
  format: "pkcs8" | "spki",
  bytes: Uint8Array,
  usage: KeyUsage,
): Promise<CryptoKey> => {
  // Keep imported key material non-extractable.
  const key = await crypto.subtle.importKey(
    format,
    bytes as BufferSource,
    RSA_SHA256,
    false,
    [usage],
  );
  const { modulusLength } = key.algorithm as RsaKeyAlgorithm;
  if (modulusLength < MIN_RSA_MODULUS_BITS) {
    throw new InvalidRsaKeySizeError(
      `RSA key must be at least ${MIN_RSA_MODULUS_BITS} bits`,
    );
  }
  return key;
};

const isInvalidRsaKeyError = (error: unknown): boolean =>
  error instanceof InvalidRsaKeySizeError ||
  (error instanceof DOMException &&
    (error.name === "DataError" || error.name === "OperationError"));

const rsaCheckPasses = async (
  check: () => Promise<unknown>,
): Promise<boolean> => {
  try {
    await check();
    return true;
  } catch (error) {
    if (!isInvalidRsaKeyError(error)) throw error;
    return false;
  }
};

const requireRsaAlgorithm = (algorithm: Uint8Array): void => {
  readDerSequence(algorithm, "RSA algorithm");
  if (!bytesEqual(algorithm, RSA_ALGORITHM)) {
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
  // Only two-prime RSA (version 0) is accepted by the Web Crypto path below.
  if (version.length !== 1 || version[0] !== 0) {
    throw new Error("Unsupported RSA private key version");
  }
  if (fields.length !== RSA_PRIVATE_KEY_FIELDS) {
    throw new Error("Unexpected RSA private key fields");
  }
};

// PKCS #8 wraps version 0, the RSA AlgorithmIdentifier, and the PKCS #1 DER
// inside an OCTET STRING.
const wrapPkcs1 = (bytes: Uint8Array): Uint8Array =>
  encodeSequence([encodeInteger(0), RSA_ALGORITHM, encodeDer(0x04, [bytes])]);

const requirePkcs8 = (bytes: Uint8Array): void => {
  const fields = readDerSequence(bytes, "private key");
  // PrivateKeyInfo starts with version, algorithm, and privateKey. Standards
  // allow optional fields after these, which Web Crypto validates on import.
  if (fields.length < 3) throw new Error("Incomplete private key");
  requireDerTag(fields[0]!, 0x02, "private key version");
  requireRsaAlgorithm(fields[1]!.encoded);
  requirePkcs1(requireDerTag(fields[2]!, 0x04, "private key bytes").contents);
};

/** Return an unencrypted RSA private key as PKCS#8 bytes for Web Crypto. */
const rsaPrivateKeyBytes = (pem: string): Uint8Array => {
  const decoded = readPem(pem, ["PRIVATE KEY", "RSA PRIVATE KEY"]);
  if (decoded.label === "RSA PRIVATE KEY") {
    requirePkcs1(decoded.bytes);
    return wrapPkcs1(decoded.bytes);
  }
  requirePkcs8(decoded.bytes);
  return decoded.bytes;
};

/** Import an unencrypted two-prime RSA signing key for SHA-256. */
export const importRsaPrivateKey = (pem: string): Promise<CryptoKey> =>
  importRsaKey("pkcs8", rsaPrivateKeyBytes(pem), "sign");

/** Import an RSA SubjectPublicKeyInfo value for SHA-256 verification. */
export const importRsaPublicKey = (bytes: Uint8Array): Promise<CryptoKey> =>
  importRsaKey("spki", bytes, "verify");

/** Whether public-key DER is importable by the RSA verification path. */
export const isValidRsaPublicKey = async (
  bytes: Uint8Array,
): Promise<boolean> => rsaCheckPasses(() => importRsaPublicKey(bytes));

/** Whether PEM is an importable RSA key that can produce a SHA-256 signature. */
export const isValidRsaPrivateKey = async (pem: string): Promise<boolean> => {
  let bytes: Uint8Array;
  try {
    bytes = rsaPrivateKeyBytes(pem);
  } catch {
    return false;
  }
  return rsaCheckPasses(async () => {
    const key = await importRsaKey("pkcs8", bytes, "sign");
    // Import alone does not prove that the private RSA parameters agree.
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new Uint8Array() as BufferSource,
    );
  });
};
