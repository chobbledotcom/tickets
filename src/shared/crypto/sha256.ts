/** The digests the scanner's offline mode is built on: a ticket token's
 * SHA-256, and its HMAC-SHA256 under one door's cache key, both lowercase
 * hex. Web Crypto, so the server answers the same digests the browser
 * checks a scan against. The hex is written out by hand: `Uint8Array.toHex`
 * is younger than the browsers a door tablet runs. */

const HEX_DIGITS = "0123456789abcdef";

/** The lowercase hex of one digest's bytes. */
const hexOf = (digest: Uint8Array): string =>
  Array.from(
    digest,
    (byte) => HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!,
  ).join("");

/** The lowercase hex of one pending Web Crypto digest. */
const hexOfDigest = async (digest: Promise<ArrayBuffer>): Promise<string> =>
  hexOf(new Uint8Array(await digest));

/** The UTF-8 bytes of one text, as the digest calls read them. */
const encoded = (value: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(value);

/** The SHA-256 of one string, as lowercase hex. The device caches these
 * digests instead of the ticket tokens themselves. */
export const sha256Hex = async (value: string): Promise<string> =>
  hexOfDigest(crypto.subtle.digest("SHA-256", encoded(value)));

/** The HMAC-SHA256 signing key: one already imported, or the raw key bytes
 * a one-off digest signs under. */
export type HmacKey = CryptoKey | Uint8Array;

/** The key one digest signs under, imported once. A caller that digests
 * many tokens imports the key one time and hands the same key to every
 * digest. */
export const importHmacKey = (key: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    // A plain ArrayBuffer-backed copy: subtle.importKey takes a plain
    // buffer, and the bytes can arrive on a shared one.
    Uint8Array.from(key),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );

/** The lowercase hex HMAC-SHA256 of one text under one key. The keyed form
 * is the digest a door's offline list holds. The list travels with a key
 * only its own scanner page carries, so a copied list digests nothing. The
 * server and the device run the same construction. The two agree byte for
 * byte. */
export const hmacHex = async (key: HmacKey, value: string): Promise<string> =>
  hexOfDigest(
    crypto.subtle.sign(
      "HMAC",
      key instanceof CryptoKey ? key : await importHmacKey(key),
      encoded(value),
    ),
  );
