/** The SHA-256 digest of one text's UTF-8 bytes, or of raw bytes. The
 * scanner's ticket-hash cache hashes on both sides, the door's endpoint and
 * the device. The two compare digests only, and both must agree byte for
 * byte. */
export const sha256Digest = (
  input: string | Uint8Array,
): Promise<ArrayBuffer> =>
  crypto.subtle.digest(
    "SHA-256",
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : // A caller's view can sit on a SharedArrayBuffer, which subtle.digest
        // refuses. The copy always carries a plain ArrayBuffer.
        Uint8Array.from(input),
  );

/** The lowercase hex SHA-256 digest of one text's UTF-8 bytes, or of raw
 * bytes. */
export const sha256Hex = async (input: string | Uint8Array): Promise<string> =>
  [...new Uint8Array(await sha256Digest(input))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
