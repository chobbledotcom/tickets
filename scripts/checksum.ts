const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));

/** FNV-1a over the text, as seven base-36 characters. Short and stable is the
 * whole contract: a registry records it beside a name, and it changes when the
 * text it was recorded against changes. */
export const shortHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(-7);
};
