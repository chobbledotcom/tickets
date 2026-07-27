import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  AES_KEY_BYTES,
  aesGcmDecryptBytes,
  aesGcmDecryptRaw,
  aesGcmEncryptBytes,
  aesGcmEncryptRaw,
} from "#shared/crypto/aes-gcm.ts";
import { getRandomBytes } from "#shared/crypto/utils.ts";

/**
 * How many bytes the authentication tag takes, read from the module's own
 * output rather than repeated here: encrypting nothing leaves a ciphertext that
 * is the tag and nothing else.
 */
const tagLength = async (): Promise<number> =>
  (await aesGcmEncryptBytes(new Uint8Array(0), getRandomBytes(AES_KEY_BYTES)))
    .ciphertext.length;

/** Sizes either side of the payload size at which the module swaps
 * implementation, so both are exercised without naming the size itself. */
const SMALL_PAYLOAD_BYTES = 64;
const BIG_PAYLOAD_BYTES = 256 * 1024;

/** Bytes that are easy to compare and long enough to span many AES blocks. A
 * prime step keeps the pattern from lining up with the 16-byte block size. */
const payload = (length: number): Uint8Array =>
  new Uint8Array(length).map((_, index) => index % 251);

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
  // The module switches implementation above a payload size it keeps to itself.
  // These sit either side of it, so both implementations run every case below.
  const sizes = [
    ["empty", 0],
    ["small", SMALL_PAYLOAD_BYTES],
    ["big enough to change implementation", BIG_PAYLOAD_BYTES],
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

  it("appends the authentication tag to the ciphertext", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(100);

    const { ciphertext } = await aesGcmEncryptBytes(data, keyBytes);

    expect(ciphertext.length).toBe(data.length + (await tagLength()));
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

  // A big payload is handed to Web Crypto, so a caller that already holds the
  // matching key can supply it rather than have one imported.
  it("takes a caller's Web Crypto key for a big payload", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(BIG_PAYLOAD_BYTES);
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

  it("never asks for a Web Crypto key for a small payload", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const data = payload(SMALL_PAYLOAD_BYTES);

    const { iv, ciphertext } = await aesGcmEncryptBytes(
      data,
      keyBytes,
      refuseWebKey,
    );

    expect(
      await aesGcmDecryptBytes(iv, ciphertext, keyBytes, refuseWebKey),
    ).toEqual(data);
  });

  // Anything shorter than the tag never came from this format. Reading a tag out
  // of it would take bytes from the wrong end, so it is refused by name.
  it("refuses ciphertext too short to hold a tag", async () => {
    const tag = await tagLength();
    const keyBytes = getRandomBytes(AES_KEY_BYTES);

    for (const length of [0, 1, tag - 1]) {
      await expect(
        aesGcmDecryptBytes(
          getRandomBytes(12),
          new Uint8Array(length),
          keyBytes,
        ),
      ).rejects.toThrow(`${length} bytes cannot hold a ${tag}-byte`);
    }
  });

  it("round-trips an empty payload, whose ciphertext is only the tag", async () => {
    const keyBytes = getRandomBytes(AES_KEY_BYTES);
    const { iv, ciphertext } = await aesGcmEncryptBytes(
      new Uint8Array(0),
      keyBytes,
    );
    expect(ciphertext.length).toBe(await tagLength());

    expect((await aesGcmDecryptBytes(iv, ciphertext, keyBytes)).length).toBe(0);
  });
});
