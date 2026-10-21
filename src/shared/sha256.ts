/** The UTF-8 bytes of one text, or a plain copy of one byte view. The copy
 * carries a plain ArrayBuffer for subtle.digest and subtle.sign. */
const messageBytes = (input: string | Uint8Array): Uint8Array<ArrayBuffer> =>
  typeof input === "string"
    ? new TextEncoder().encode(input)
    : Uint8Array.from(input);

/** The lowercase hex of one digest's bytes. */
const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** SHA-256 digests, keyed with HMAC, for code the server and the browser
 * share. The scanner's ticket-hash cache digests on both sides with the
 * keyed form. The door's endpoint and the device hold the same door key, and
 * the two must agree byte for byte. The key travels only on the scanner
 * page, never in the cache response. */
export const sha256Digest = (
  input: string | Uint8Array,
): Promise<ArrayBuffer> => crypto.subtle.digest("SHA-256", messageBytes(input));

/** The HMAC-SHA256 digest of one text's UTF-8 bytes, or of raw bytes, under
 * one key. The same construction runs on both sides of the door cache. Node
 * derives the key on the server. The browser signs with the bytes the
 * scanner page carries. */
export const hmacDigest = async (
  key: Uint8Array | string,
  input: string | Uint8Array,
): Promise<ArrayBuffer> =>
  crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey(
      "raw",
      messageBytes(key),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    ),
    messageBytes(input),
  );

/** The lowercase hex of one digest promise's bytes. */
const hexOf = async (digest: Promise<ArrayBuffer>): Promise<string> =>
  toHex(await digest);

/** The lowercase hex SHA-256 digest of one text's UTF-8 bytes, or of raw
 * bytes. */
export const sha256Hex = (input: string | Uint8Array): Promise<string> =>
  hexOf(sha256Digest(input));

/** The lowercase hex keyed digest of one text's UTF-8 bytes, or of raw
 * bytes. */
export const hmacHex = (
  key: Uint8Array | string,
  input: string | Uint8Array,
): Promise<string> => hexOf(hmacDigest(key, input));
