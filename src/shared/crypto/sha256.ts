/**
 * The one digest the scanner's offline mode is built on: a ticket token's
 * SHA-256, as lowercase hex. Web Crypto, so the server answers the same
 * digests the browser checks a scan against. The hex is written out by hand:
 * `Uint8Array.toHex` is younger than the browsers a door tablet runs.
 */

const HEX_DIGITS = "0123456789abcdef";

/** The SHA-256 of one string, as lowercase hex. The device caches these
 * digests instead of the ticket tokens themselves. */
export const sha256Hex = async (value: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(
    digest,
    (byte) => HEX_DIGITS[byte >> 4]! + HEX_DIGITS[byte & 15]!,
  ).join("");
};
