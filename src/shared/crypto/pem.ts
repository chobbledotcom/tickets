import { fromBase64 } from "#shared/crypto/utils.ts";

export interface PemValue {
  bytes: Uint8Array;
  label: string;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
// Require complete four-character groups and legal final padding before decode.
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// OpenSSL PKCS #12 exports may print these human-readable fields around the
// actual PEM block. They are not part of the key or certificate bytes.
const EXPORT_METADATA_LINE =
  /^(?:Bag Attributes|Key Attributes:.*|subject=.*|issuer=.*|[ \t]+(?:friendlyName|localKeyID|Microsoft CSP Name|[0-9]+(?:\.[0-9]+)+):.*)$/;

const isExportMetadata = (text: string): boolean =>
  text
    .split(/\r?\n/)
    .every(
      (line) => line.trim().length === 0 || EXPORT_METADATA_LINE.test(line),
    );

/** Decode one unencrypted PEM block, allowing standard export metadata. */
export const readPem = (
  pem: string,
  allowedLabels: readonly string[],
): PemValue => {
  const matches = [...pem.matchAll(PEM_BLOCK)];
  if (matches.length !== 1) throw new Error("Expected one PEM block");
  const match = matches[0]!;
  const before = pem.slice(0, match.index);
  const after = pem.slice(match.index! + match[0].length);
  if (!isExportMetadata(before) || !isExportMetadata(after)) {
    throw new Error("Unexpected data outside PEM block");
  }
  const label = match[1]!;
  if (!allowedLabels.includes(label))
    throw new Error(`Unexpected PEM label: ${label}`);
  const base64 = match[2]!.replace(/\s/g, "");
  if (!BASE64.test(base64)) throw new Error("Invalid PEM base64 data");
  return { bytes: fromBase64(base64), label };
};
