import {
  encodeInteger,
  encodeNull,
  encodeOid,
  encodeSequence,
} from "#shared/crypto/der.ts";

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
