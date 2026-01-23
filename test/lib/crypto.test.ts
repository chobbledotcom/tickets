import { afterEach, beforeEach, describe, expect, it } from "#test-compat";
import {
  clearEncryptionKeyCache,
  constantTimeEqual,
  decrypt,
  encrypt,
  generateSecureToken,
  hashPassword,
  validateEncryptionKey,
  verifyPassword,
} from "#lib/crypto.ts";
import {
  clearTestEncryptionKey,
  setupTestEncryptionKey,
  TEST_ENCRYPTION_KEY,
} from "#test-utils";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("hello", "hello")).toBe(true);
    expect(constantTimeEqual("test123", "test123")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(constantTimeEqual("hello", "hallo")).toBe(false);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("aaa", "aab")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(constantTimeEqual("hello", "hell")).toBe(false);
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(constantTimeEqual("test", "testing")).toBe(false);
  });

  it("handles special characters", () => {
    expect(constantTimeEqual("!@#$%", "!@#$%")).toBe(true);
    expect(constantTimeEqual("!@#$%", "!@#$&")).toBe(false);
  });

  it("handles unicode characters", () => {
    expect(constantTimeEqual("héllo", "héllo")).toBe(true);
    expect(constantTimeEqual("héllo", "hèllo")).toBe(false);
  });
});

describe("generateSecureToken", () => {
  it("returns a non-empty string", () => {
    const token = generateSecureToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("returns base64url encoded string without padding", () => {
    const token = generateSecureToken();
    // base64url uses only alphanumeric, -, and _
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // Should not contain +, /, or =
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateSecureToken());
    }
    // All 100 tokens should be unique
    expect(tokens.size).toBe(100);
  });

  it("generates tokens of consistent length", () => {
    // 32 bytes = 256 bits, base64 encodes 6 bits per char
    // 256/6 = ~43 chars (without padding)
    const token = generateSecureToken();
    expect(token.length).toBe(43);
  });
});

describe("encryption", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  afterEach(() => {
    clearTestEncryptionKey();
  });

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
      Deno.env.set("DB_ENCRYPTION_KEY", btoa("tooshort"));
      clearEncryptionKeyCache();
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
    it("caches the key between operations", async () => {
      const plaintext = "test";
      // First encryption imports the key
      await encrypt(plaintext);
      // Second encryption should use cached key
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it("invalidates cache when key changes", async () => {
      const plaintext = "test";
      const encrypted = await encrypt(plaintext);

      // Generate a different valid 32-byte key
      const newKey = btoa("abcdefghijklmnopqrstuvwxyz012345");
      Deno.env.set("DB_ENCRYPTION_KEY", newKey);
      clearEncryptionKeyCache();

      // Decryption with new key should fail
      await expect(decrypt(encrypted)).rejects.toThrow();

      // Restore original key
      Deno.env.set("DB_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
      clearEncryptionKeyCache();

      // Now decryption should work again
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });
});

describe("password hashing", () => {
  describe("hashPassword", () => {
    it("returns pbkdf2 format with all parameters", async () => {
      const hash = await hashPassword("mypassword");
      expect(hash.startsWith("pbkdf2:")).toBe(true);
      const parts = hash.split(":");
      expect(parts.length).toBe(4);
      expect(parts[0]).toBe("pbkdf2");
    });

    it("generates different hashes for same password (random salt)", async () => {
      const hash1 = await hashPassword("samepassword");
      const hash2 = await hashPassword("samepassword");
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("verifyPassword", () => {
    it("returns true for correct password", async () => {
      const hash = await hashPassword("correctpassword");
      const result = await verifyPassword("correctpassword", hash);
      expect(result).toBe(true);
    });

    it("returns false for wrong password", async () => {
      const hash = await hashPassword("correctpassword");
      const result = await verifyPassword("wrongpassword", hash);
      expect(result).toBe(false);
    });

    it("returns false for invalid hash format (wrong prefix)", async () => {
      const result = await verifyPassword("password", "argon2:invalid:format");
      expect(result).toBe(false);
    });

    it("returns false for malformed hash (wrong number of parts)", async () => {
      const result = await verifyPassword("password", "pbkdf2:100000:salt");
      expect(result).toBe(false);
    });

    it("returns false for hash with mismatched length", async () => {
      // Create a valid-looking hash but with truncated hash data
      const shortHash = btoa("short");
      const salt = btoa("0123456789012345");
      const result = await verifyPassword(
        "password",
        `pbkdf2:100000:${salt}:${shortHash}`,
      );
      expect(result).toBe(false);
    });
  });
});
