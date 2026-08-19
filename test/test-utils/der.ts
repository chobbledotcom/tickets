import {
  encodeDer,
  encodeInteger,
  encodeNull,
  encodeOid,
  encodeSequence,
} from "#crypto/der.ts";

export const RSA_ENCRYPTION_OID = "1.2.840.113549.1.1.1";

export const pemFor = (label: string, bytes: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${bytes.toBase64()}\n-----END ${label}-----\n`;

export const rsaAlgorithm = (): Uint8Array =>
  encodeSequence([encodeOid(RSA_ENCRYPTION_OID), encodeNull()]);

export const rsaPrivateKey = (version = 0, fields = 9): Uint8Array =>
  encodeSequence(
    Array.from({ length: fields }, (_, index) =>
      encodeInteger(index === 0 ? version : index),
    ),
  );

/** A structurally complete certificate whose subject public key is EC, as
 * Apple's WWDR G2 intermediate is. It is only used to prove that intermediate
 * certificates are embedded without applying the RSA leaf-key rule. */
export const nonRsaCertificatePem = (): string => {
  // DER BIT STRING content starts with the count of unused bits (zero here).
  const bitString = encodeDer(0x03, [new Uint8Array([0, 1])]);
  // id-ecPublicKey marks SubjectPublicKeyInfo as EC rather than RSA.
  const ecAlgorithm = encodeSequence([encodeOid("1.2.840.10045.2.1")]);
  const body = encodeSequence([
    // [0] EXPLICIT INTEGER 2 means X.509 version 3.
    encodeDer(0xa0, [encodeInteger(2)]),
    // These small values are arbitrary fixture serial and issuer values.
    encodeInteger(42),
    rsaAlgorithm(),
    encodeSequence([encodeInteger(7)]),
    encodeSequence([]),
    encodeSequence([]),
    encodeSequence([ecAlgorithm, bitString]),
  ]);
  return pemFor(
    "CERTIFICATE",
    encodeSequence([body, rsaAlgorithm(), bitString]),
  );
};
