/**
 * Tests for the crypto module
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  decrypt,
  decryptNullable,
  encrypt,
  encryptNullable,
  resetEncryptionKey,
} from "#lib/crypto.ts";

describe("crypto", () => {
  const originalKey = process.env.DB_ENCRYPTION_KEY;

  beforeEach(() => {
    resetEncryptionKey();
    // Set a valid 32-byte key for tests
    process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    resetEncryptionKey();
    process.env.DB_ENCRYPTION_KEY = originalKey;
  });

  describe("encrypt/decrypt", () => {
    test("encrypts and decrypts a string", () => {
      const plaintext = "Hello, World!";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    test("encrypted value is different from plaintext", () => {
      const plaintext = "sensitive data";
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).not.toContain(plaintext);
    });

    test("encrypted value has correct format (iv:ciphertext:authTag)", () => {
      const encrypted = encrypt("test");
      const parts = encrypted.split(":");
      expect(parts.length).toBe(3);
      // Each part should be valid base64
      for (const part of parts) {
        expect(() => Buffer.from(part, "base64")).not.toThrow();
      }
    });

    test("encrypts same plaintext to different ciphertexts (unique IVs)", () => {
      const plaintext = "same text";
      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);
      expect(encrypted1).not.toBe(encrypted2);
      // But both should decrypt to the same value
      expect(decrypt(encrypted1)).toBe(plaintext);
      expect(decrypt(encrypted2)).toBe(plaintext);
    });

    test("handles single character", () => {
      const plaintext = "a";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    test("handles unicode characters", () => {
      const plaintext = "Hello \u{1F600} World \u{1F389}";
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    test("handles long strings", () => {
      const plaintext = "a".repeat(10000);
      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    test("throws on invalid encrypted data format", () => {
      expect(() => decrypt("invalid")).toThrow("Invalid encrypted data format");
      expect(() => decrypt("a:b")).toThrow("Invalid encrypted data format");
      expect(() => decrypt("a:b:c:d")).toThrow("Invalid encrypted data format");
      // Empty parts
      expect(() => decrypt("::")).toThrow("Invalid encrypted data format");
      expect(() => decrypt("a::c")).toThrow("Invalid encrypted data format");
    });

    test("throws on invalid IV length", () => {
      // Valid base64 but wrong IV length (should be 12 bytes)
      const wrongIv = Buffer.from("short").toString("base64");
      const ciphertext = Buffer.from("test").toString("base64");
      const authTag = Buffer.from("0".repeat(16)).toString("base64");
      expect(() => decrypt(`${wrongIv}:${ciphertext}:${authTag}`)).toThrow(
        "Invalid IV length",
      );
    });

    test("throws on invalid auth tag length", () => {
      // Valid IV (12 bytes) but wrong auth tag length (should be 16 bytes)
      const iv = Buffer.from("0".repeat(12)).toString("base64");
      const ciphertext = Buffer.from("test").toString("base64");
      const wrongAuthTag = Buffer.from("short").toString("base64");
      expect(() => decrypt(`${iv}:${ciphertext}:${wrongAuthTag}`)).toThrow(
        "Invalid auth tag length",
      );
    });

    test("throws on tampered ciphertext", () => {
      const encrypted = encrypt("test");
      const parts = encrypted.split(":");
      // Tamper with the ciphertext
      parts[1] = Buffer.from("tampered").toString("base64");
      const tampered = parts.join(":");
      expect(() => decrypt(tampered)).toThrow();
    });

    test("throws on tampered auth tag", () => {
      const encrypted = encrypt("test");
      const parts = encrypted.split(":");
      // Tamper with the auth tag
      parts[2] = Buffer.from("0".repeat(16)).toString("base64");
      const tampered = parts.join(":");
      expect(() => decrypt(tampered)).toThrow();
    });
  });

  describe("encryptNullable/decryptNullable", () => {
    test("returns null for null input", () => {
      expect(encryptNullable(null)).toBeNull();
      expect(decryptNullable(null)).toBeNull();
    });

    test("encrypts and decrypts non-null values", () => {
      const plaintext = "test value";
      const encrypted = encryptNullable(plaintext);
      expect(encrypted).not.toBeNull();
      const decrypted = decryptNullable(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe("encryption key validation", () => {
    test("throws when encryption key is not set", () => {
      delete process.env.DB_ENCRYPTION_KEY;
      resetEncryptionKey();
      expect(() => encrypt("test")).toThrow(
        "DB_ENCRYPTION_KEY environment variable is required",
      );
    });

    test("throws when encryption key is wrong length", () => {
      process.env.DB_ENCRYPTION_KEY = Buffer.from("short").toString("base64");
      resetEncryptionKey();
      expect(() => encrypt("test")).toThrow(
        "DB_ENCRYPTION_KEY must be 32 bytes",
      );
    });

    test("caches encryption key after first use", () => {
      const key1 = randomBytes(32).toString("base64");
      process.env.DB_ENCRYPTION_KEY = key1;
      resetEncryptionKey();

      const encrypted = encrypt("test");

      // Change the env var (shouldn't affect cached key)
      process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("base64");

      // Should still decrypt correctly with cached key
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe("test");
    });
  });

  describe("cross-key decryption", () => {
    test("throws when decrypting with wrong key", () => {
      const encrypted = encrypt("secret");

      // Change to a different key
      process.env.DB_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      resetEncryptionKey();

      expect(() => decrypt(encrypted)).toThrow();
    });
  });
});
