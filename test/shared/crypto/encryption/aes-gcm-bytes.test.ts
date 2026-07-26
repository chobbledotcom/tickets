import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  AES_KEY_BYTES,
  aesGcmDecryptBytes,
  aesGcmDecryptRaw,
  aesGcmEncryptBytes,
  aesGcmEncryptRaw,
  NODE_AES_MAX_BYTES,
} from "#shared/crypto/encryption.ts";
import { getRandomBytes } from "#shared/crypto/utils.ts";

/** Bytes that are easy to compare and long enough to span many AES blocks. */
const payload = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => i % 251);

/** The 16-byte AES-GCM authentication tag appended to every ciphertext. */
const GCM_TAG_BYTES = 16;

/** Stands in where the size threshold means no Web Crypto key may be asked for. */
const refuseWebKey = (): Promise<CryptoKey> => {
  throw new Error("asked for a Web Crypto key below the size threshold");
};

/** The same key bytes as a Web Crypto key, for the cross-checks below. */
const asWebKey = (
  keyBytes: Uint8Array,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "AES-GCM" },
    false,
    [usage],
  );

describe("aesGcmEncryptBytes / aesGcmDecryptBytes", () => {
  // Both sides of the size threshold, plus the exact boundary, so the small and
  // large implementations are each exercised by every case below.
  const sizes = [
    ["empty", 0],
    ["small", 64],
    ["at the size threshold", NODE_AES_MAX_BYTES],
    ["over the size threshold", NODE_AES_MAX_BYTES + 1],
  ] as const;

  for (const [label, size] of sizes) {
    it(`round-trips a payload ${label}`, async () => {
      const keyBytes = getRandomBytes(AES_KEY_BYTES);
      const data = payload(size);

      const { iv, ciphertext } = await aesGcmEncryptBytes(data, keyBytes);
      const decrypted = await aesGcmDecryptBytes(iv, ciphertext, keyBytes);

      expect(decrypted).toEqual(data);
    });

    // The size threshold is a speed choice, so whichever implementation runs
    // must produce bytes the other one can read. A payload encrypted below the
    // threshold and decrypted above it (or the reverse) has to survive.
    it(`produces Web Crypto readable output ${label}`, async () => {
      const keyBytes = getRandomBytes(AES_KEY_BYTES);
      const data = payload(size);

      const { iv, ciphertext } = await aesGcmEncryptBytes(data, keyBytes);
      const decrypted = await aesGcmDecryptRaw(
        iv,
        ciphertext,
        await asWebKey(keyBytes, "decrypt"),
      );

      expect(new Uint8Array(decrypted)).toEqual(data);
    });

    it(`reads Web Crypto written output ${label}`, async () => {
      const keyBytes = getRandomBytes(AES_KEY_BYTES);
      const data = payload(size);

      const { iv, ciphertext } = await aesGcmEncryptRaw(
        data as BufferSource,
        await asWebKey(keyBytes, "encrypt"),
      );
      const decrypted = await aesGcmDecryptBytes(iv, ciphertext, keyBytes);

      expect(decrypted).toEqual(data);
    });
  }

  it("uses a fresh random IV for every encryption", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(64);

    const first = await aesGcmEncryptBytes(data, keyBytes);
    const second = await aesGcmEncryptBytes(data, keyBytes);

    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  it("appends the 16-byte authentication tag to the ciphertext", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(100);

    const { ciphertext } = await aesGcmEncryptBytes(data, keyBytes);

    expect(ciphertext.length).toBe(data.length + GCM_TAG_BYTES);
  });

  it("rejects a payload decrypted with the wrong key", async () => {
    const data = payload(64);
    const { iv, ciphertext } = await aesGcmEncryptBytes(
      data,
      getRandomBytes(AES_KEY_BYTES),
    );

    await expect(
      aesGcmDecryptBytes(iv, ciphertext, getRandomBytes(AES_KEY_BYTES)),
    ).rejects.toThrow();
  });

  it("rejects ciphertext whose contents were altered", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const { iv, ciphertext } = await aesGcmEncryptBytes(payload(64), keyBytes);
    ciphertext[0] = ciphertext[0]! ^ 0xff;

    await expect(
      aesGcmDecryptBytes(iv, ciphertext, keyBytes),
    ).rejects.toThrow();
  });

  it("takes a caller's Web Crypto key instead of importing one", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(NODE_AES_MAX_BYTES + 1);
    let imports = 0;
    const webKey = (usage: "encrypt" | "decrypt") => () => {
      imports += 1;
      return asWebKey(keyBytes, usage);
    };

    const { iv, ciphertext } = await aesGcmEncryptBytes(
      data,
      keyBytes,
      webKey("encrypt"),
    );
    const decrypted = await aesGcmDecryptBytes(
      iv,
      ciphertext,
      keyBytes,
      webKey("decrypt"),
    );

    expect(decrypted).toEqual(data);
    expect(imports).toBe(2);
  });

  // Each side measures the bytes it is handed, and the ciphertext carries a
  // 16-byte tag the plaintext does not — so the two thresholds are checked
  // separately, each against the largest input that must stay off Web Crypto.
  it("encrypts a payload at the threshold without a Web Crypto key", async () => {
    const { ciphertext } = await aesGcmEncryptBytes(
      payload(NODE_AES_MAX_BYTES),
      getRandomBytes(AES_KEY_BYTES),
      refuseWebKey,
    );

    expect(ciphertext.length).toBe(NODE_AES_MAX_BYTES + GCM_TAG_BYTES);
  });

  it("decrypts ciphertext at the threshold without a Web Crypto key", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(NODE_AES_MAX_BYTES - GCM_TAG_BYTES);
    const { iv, ciphertext } = await aesGcmEncryptBytes(data, keyBytes);
    expect(ciphertext.length).toBe(NODE_AES_MAX_BYTES);

    expect(
      await aesGcmDecryptBytes(iv, ciphertext, keyBytes, refuseWebKey),
    ).toEqual(data);
  });
});
