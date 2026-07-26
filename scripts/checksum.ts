const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
