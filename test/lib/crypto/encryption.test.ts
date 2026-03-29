import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  decrypt,
  decryptWithKey,
  encrypt,
  encryptWithKey,
  setEncryptionKeyForTest,
  validateEncryptionKey,
} from "#lib/crypto/encryption.ts";
import { generateDataKey } from "#lib/crypto/keys.ts";
import {
  clearTestEncryptionKey,
  describeWithEnv,
  setupTestEncryptionKey,
} from "#test-utils";

describeWithEnv("encryption", { encryptionKey: true }, () => {
  describe("validateEncryptionKey", () => {
    it("succeeds with valid 32-byte key", () => {
      expect(() => validateEncryptionKey()).not.toThrow();
    });

    it("throws when no key is set", () => {
      clearTestEncryptionKey();
      expect(() => validateEncryptionKey()).toThrow(
        "DB_ENCRYPTION_KEY environment variable is required",
      );
    });

    it("throws when key is wrong length", () => {
      setEncryptionKeyForTest(btoa("tooshort"));
      expect(() => validateEncryptionKey()).toThrow(
        "DB_ENCRYPTION_KEY must be 32 bytes",
      );
    });
  });

  describe("encrypt and decrypt", () => {
    it("round-trips a simple string", async () => {
      const plaintext = "hello world";
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips an empty string", async () => {
      const plaintext = "";
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips unicode characters", async () => {
      const plaintext = "こんにちは世界 🌍 émojis";
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips a long string", async () => {
      const plaintext = "a".repeat(10000);
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext (random IV)", async () => {
      const plaintext = "same text";
      const encrypted1 = await encrypt(plaintext);
      const encrypted2 = await encrypt(plaintext);
      expect(encrypted1).not.toBe(encrypted2);
      // But both decrypt to same value
      expect(await decrypt(encrypted1)).toBe(plaintext);
      expect(await decrypt(encrypted2)).toBe(plaintext);
    });

    it("encrypted output has correct prefix", async () => {
      const encrypted = await encrypt("test");
      expect(encrypted.startsWith("enc:1:")).toBe(true);
    });

    it("throws on invalid encrypted format", async () => {
      await expect(decrypt("not encrypted")).rejects.toThrow(
        "Invalid encrypted data format",
      );
    });

    it("throws on malformed encrypted data (missing IV separator)", async () => {
      await expect(decrypt("enc:1:nocol")).rejects.toThrow(
        "Invalid encrypted data format: missing IV separator",
      );
    });

    it("throws on tampered ciphertext", async () => {
      const encrypted = await encrypt("test");
      // Tamper with the ciphertext portion (format is enc:1:iv:ciphertext)
      const parts = encrypted.split(":");
      const ciphertext = parts[3];
      if (ciphertext) {
        parts[3] = `AAAA${ciphertext.slice(4)}`;
      }
      const tampered = parts.join(":");
      await expect(decrypt(tampered)).rejects.toThrow();
    });
  });

  describe("key caching", () => {
    it("invalidates cache when key changes", async () => {
      const plaintext = "test";
      const encrypted = await encrypt(plaintext);

      // Generate a different valid 32-byte key
      const newKey = btoa("abcdefghijklmnopqrstuvwxyz012345");
      setEncryptionKeyForTest(newKey);

      // Decryption with new key should fail
      await expect(decrypt(encrypted)).rejects.toThrow();

      // Restore original key
      setupTestEncryptionKey();

      // Now decryption should work again
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });
});

describe("encryptWithKey and decryptWithKey", () => {
  it("round-trips data with a generated key", async () => {
    const key = await generateDataKey();
    const plaintext = "secret message";

    const encrypted = await encryptWithKey(plaintext, key);
    const decrypted = await decryptWithKey(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it("uses same format as regular encrypt", async () => {
    const key = await generateDataKey();
    const encrypted = await encryptWithKey("test", key);
    expect(encrypted.startsWith("enc:1:")).toBe(true);
  });

  it("fails with wrong key", async () => {
    const key1 = await generateDataKey();
    const key2 = await generateDataKey();

    const encrypted = await encryptWithKey("secret", key1);
    await expect(decryptWithKey(encrypted, key2)).rejects.toThrow();
  });

  it("throws on invalid encrypted data format (missing prefix)", async () => {
    const key = await generateDataKey();
    await expect(decryptWithKey("invalid-data", key)).rejects.toThrow(
      "Invalid encrypted data format",
    );
  });

  it("throws on invalid encrypted data format (missing IV separator)", async () => {
    const key = await generateDataKey();
    await expect(decryptWithKey("enc:1:nodatahere", key)).rejects.toThrow(
      "Invalid encrypted data format: missing IV separator",
    );
  });
});
