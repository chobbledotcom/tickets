import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  decrypt,
  decryptWithKey,
  encrypt,
  encryptWithKey,
  getEncryptionKeyBytes,
  parseEncryptedPayload,
  setEncryptionKeyForTest,
  validateEncryptionKey,
} from "#shared/crypto/encryption.ts";
import { generateDataKey } from "#shared/crypto/keys.ts";
import { toBase64 } from "#shared/crypto/utils.ts";
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

    it("re-runs the key initializer when the override is cleared to null", () => {
      // Clearing to null (not "") resets the lazyRef holding the override, so
      // the next read re-runs its initializer and falls through to
      // DB_ENCRYPTION_KEY. That env var is set in CI but not locally, so assert
      // against whatever it holds — either way this exercises the env-lookup
      // branch that otherwise only the e2e subprocess covers.
      setEncryptionKeyForTest(null);
      if (Deno.env.get("DB_ENCRYPTION_KEY")) {
        expect(() => validateEncryptionKey()).not.toThrow();
      } else {
        expect(() => validateEncryptionKey()).toThrow(
          "DB_ENCRYPTION_KEY environment variable is required",
        );
      }
      setupTestEncryptionKey(); // restore the override for sibling tests
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

  // Encryption was migrated from Web Crypto to node:crypto for speed. Both emit
  // standard AES-256-GCM with the auth tag appended, so existing data must stay
  // decryptable and new data must remain readable by the Web Crypto primitives.
  describe("Web Crypto interoperability", () => {
    it("decrypts ciphertext produced by the Web Crypto path (backward compatibility)", async () => {
      const plaintext = "value-encrypted-before-the-migration";
      const key = await crypto.subtle.importKey(
        "raw",
        getEncryptionKeyBytes() as BufferSource,
        { name: "AES-GCM" },
        false,
        ["encrypt"],
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { iv, name: "AES-GCM" },
          key,
          new TextEncoder().encode(plaintext),
        ),
      );
      const legacy = `enc:1:${toBase64(iv)}:${toBase64(ciphertext)}`;
      expect(await decrypt(legacy)).toBe(plaintext);
    });

    it("produces ciphertext the Web Crypto path can decrypt", async () => {
      const plaintext = "value-encrypted-after-the-migration";
      const { ciphertext, iv } = parseEncryptedPayload(
        await encrypt(plaintext),
        "enc:1:",
        "encrypted data",
      );
      const key = await crypto.subtle.importKey(
        "raw",
        getEncryptionKeyBytes() as BufferSource,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );
      const decrypted = await crypto.subtle.decrypt(
        { iv: iv as BufferSource, name: "AES-GCM" },
        key,
        ciphertext as BufferSource,
      );
      expect(new TextDecoder().decode(decrypted)).toBe(plaintext);
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
