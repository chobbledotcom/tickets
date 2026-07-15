import { fromBase64 } from "#shared/crypto/utils.ts";

export interface PemValue {
  bytes: Uint8Array;
  label: string;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode one unencrypted PEM block and reject any extra non-whitespace data. */
export const readPem = (
  pem: string,
  allowedLabels: readonly string[],
): PemValue => {
  const matches = [...pem.matchAll(PEM_BLOCK)];
  if (matches.length !== 1) throw new Error("Expected one PEM block");
  const match = matches[0]!;
  if (
    `${pem.slice(0, match.index)}${pem.slice(match.index! + match[0].length)}`.trim()
  ) {
    throw new Error("Unexpected data outside PEM block");
  }
  const label = match[1]!;
  if (!allowedLabels.includes(label))
    throw new Error(`Unexpected PEM label: ${label}`);
  const base64 = match[2]!.replace(/\s/g, "");
  if (!BASE64.test(base64)) throw new Error("Invalid PEM base64 data");
  return { bytes: fromBase64(base64), label };
};
