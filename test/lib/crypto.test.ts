import { afterEach, beforeEach, describe, expect, it } from "#test-compat";
import {
  clearEncryptionKeyCache,
  constantTimeEqual,
  decrypt,
  decryptWithKey,
  deriveKEK,
  encrypt,
  encryptWithKey,
  generateDataKey,
  generateKeyPair,
  generateSecureToken,
  hashPassword,
  hashSessionToken,
  hmacHash,
  hybridDecrypt,
  hybridEncrypt,
  importPrivateKey,
  importPublicKey,
  unwrapKey,
  unwrapKeyWithToken,
  validateEncryptionKey,
  verifyPassword,
  wrapKey,
  wrapKeyWithToken,
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

describe("session token hashing", () => {
  it("produces consistent hash for same token", async () => {
    const token = "test-session-token-123";
    const hash1 = await hashSessionToken(token);
    const hash2 = await hashSessionToken(token);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different tokens", async () => {
    const hash1 = await hashSessionToken("token1");
    const hash2 = await hashSessionToken("token2");
    expect(hash1).not.toBe(hash2);
  });

  it("returns base64 encoded string", async () => {
    const hash = await hashSessionToken("test-token");
    // SHA-256 produces 32 bytes, base64 encodes to 44 characters (with padding)
    expect(hash.length).toBe(44);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("hmacHash", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  afterEach(() => {
    clearTestEncryptionKey();
  });

  it("produces consistent hash for same IP", async () => {
    const ip = "192.168.1.1";
    const hash1 = await hmacHash(ip);
    const hash2 = await hmacHash(ip);
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different IPs", async () => {
    const hash1 = await hmacHash("192.168.1.1");
    const hash2 = await hmacHash("192.168.1.2");
    expect(hash1).not.toBe(hash2);
  });

  it("returns base64 encoded string", async () => {
    const hash = await hmacHash("10.0.0.1");
    // HMAC-SHA-256 produces 32 bytes, base64 encodes to 44 characters (with padding)
    expect(hash.length).toBe(44);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("produces different hashes with different encryption keys", async () => {
    const ip = "192.168.1.1";
    const hash1 = await hmacHash(ip);

    // Change the encryption key
    clearTestEncryptionKey();
    Deno.env.set(
      "DB_ENCRYPTION_KEY",
      "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=",
    );

    const hash2 = await hmacHash(ip);
    expect(hash1).not.toBe(hash2);

    // Restore original key
    clearTestEncryptionKey();
    setupTestEncryptionKey();
  });

  it("handles IPv6 addresses", async () => {
    const hash = await hmacHash("2001:db8::1");
    expect(hash.length).toBe(44);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("handles special fallback value", async () => {
    const hash = await hmacHash("direct");
    expect(hash.length).toBe(44);
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("KEK derivation", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  afterEach(() => {
    clearTestEncryptionKey();
  });

  it("derives a usable CryptoKey", async () => {
    const passwordHash = "pbkdf2:1000:c2FsdA==:aGFzaA==";
    const kek = await deriveKEK(passwordHash);
    expect(kek).toBeDefined();
    expect(kek.type).toBe("secret");
  });

  it("produces same key for same inputs", async () => {
    const passwordHash = "pbkdf2:1000:c2FsdA==:aGFzaA==";
    const kek1 = await deriveKEK(passwordHash);
    const kek2 = await deriveKEK(passwordHash);

    // Wrap/unwrap with each to verify they're equivalent
    const dataKey = await generateDataKey();
    const wrapped1 = await wrapKey(dataKey, kek1);
    const unwrapped = await unwrapKey(wrapped1, kek2);
    expect(unwrapped).toBeDefined();
  });

  it("produces different keys for different password hashes", async () => {
    const kek1 = await deriveKEK("hash1");
    const kek2 = await deriveKEK("hash2");

    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, kek1);

    // Should fail to unwrap with different KEK
    await expect(unwrapKey(wrapped, kek2)).rejects.toThrow();
  });
});

describe("key wrapping", () => {
  beforeEach(() => {
    setupTestEncryptionKey();
  });

  afterEach(() => {
    clearTestEncryptionKey();
  });

  describe("wrapKey and unwrapKey", () => {
    it("round-trips a data key", async () => {
      const dataKey = await generateDataKey();
      const kek = await deriveKEK("test-hash");

      const wrapped = await wrapKey(dataKey, kek);
      const unwrapped = await unwrapKey(wrapped, kek);

      // Verify by encrypting/decrypting with both keys
      const plaintext = "test data";
      const encrypted = await encryptWithKey(plaintext, dataKey);
      const decrypted = await decryptWithKey(encrypted, unwrapped);
      expect(decrypted).toBe(plaintext);
    });

    it("produces wrapped key with correct prefix", async () => {
      const dataKey = await generateDataKey();
      const kek = await deriveKEK("test-hash");
      const wrapped = await wrapKey(dataKey, kek);
      expect(wrapped.startsWith("wk:1:")).toBe(true);
    });

    it("throws on invalid format", async () => {
      const kek = await deriveKEK("test-hash");
      await expect(unwrapKey("invalid", kek)).rejects.toThrow(
        "Invalid wrapped key format",
      );
    });

    it("throws on missing IV separator", async () => {
      const kek = await deriveKEK("test-hash");
      await expect(unwrapKey("wk:1:nocoIon", kek)).rejects.toThrow(
        "Invalid wrapped key format: missing IV separator",
      );
    });
  });

  describe("wrapKeyWithToken and unwrapKeyWithToken", () => {
    it("round-trips a data key using session token", async () => {
      const dataKey = await generateDataKey();
      const sessionToken = generateSecureToken();

      const wrapped = await wrapKeyWithToken(dataKey, sessionToken);
      const unwrapped = await unwrapKeyWithToken(wrapped, sessionToken);

      // Verify by encrypting/decrypting
      const plaintext = "test data";
      const encrypted = await encryptWithKey(plaintext, dataKey);
      const decrypted = await decryptWithKey(encrypted, unwrapped);
      expect(decrypted).toBe(plaintext);
    });

    it("fails with wrong session token", async () => {
      const dataKey = await generateDataKey();
      const token1 = generateSecureToken();
      const token2 = generateSecureToken();

      const wrapped = await wrapKeyWithToken(dataKey, token1);
      await expect(unwrapKeyWithToken(wrapped, token2)).rejects.toThrow();
    });

    it("throws on invalid wrapped key format (missing prefix)", async () => {
      const sessionToken = generateSecureToken();
      await expect(
        unwrapKeyWithToken("invalid-data", sessionToken),
      ).rejects.toThrow("Invalid wrapped key format");
    });

    it("throws on invalid wrapped key format (missing IV separator)", async () => {
      const sessionToken = generateSecureToken();
      await expect(
        unwrapKeyWithToken("wk:1:nodatahere", sessionToken),
      ).rejects.toThrow("Invalid wrapped key format: missing IV separator");
    });
  });
});

describe("RSA key pair and hybrid encryption", () => {
  describe("generateKeyPair", () => {
    it("generates valid key pair", async () => {
      const { publicKey, privateKey } = await generateKeyPair();
      expect(publicKey).toBeDefined();
      expect(privateKey).toBeDefined();
      expect(JSON.parse(publicKey).kty).toBe("RSA");
      expect(JSON.parse(privateKey).kty).toBe("RSA");
    });

    it("generates different key pairs each time", async () => {
      const pair1 = await generateKeyPair();
      const pair2 = await generateKeyPair();
      expect(pair1.publicKey).not.toBe(pair2.publicKey);
      expect(pair1.privateKey).not.toBe(pair2.privateKey);
    });
  });

  describe("hybridEncrypt and hybridDecrypt", () => {
    it("round-trips a simple string", async () => {
      const { publicKey, privateKey } = await generateKeyPair();
      const pubKey = await importPublicKey(publicKey);
      const privKey = await importPrivateKey(privateKey);

      const plaintext = "hello world";
      const encrypted = await hybridEncrypt(plaintext, pubKey);
      const decrypted = await hybridDecrypt(encrypted, privKey);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips unicode and emoji", async () => {
      const { publicKey, privateKey } = await generateKeyPair();
      const pubKey = await importPublicKey(publicKey);
      const privKey = await importPrivateKey(privateKey);

      const plaintext = "こんにちは 🌍 émojis";
      const encrypted = await hybridEncrypt(plaintext, pubKey);
      const decrypted = await hybridDecrypt(encrypted, privKey);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext", async () => {
      const { publicKey } = await generateKeyPair();
      const pubKey = await importPublicKey(publicKey);

      const encrypted1 = await hybridEncrypt("same text", pubKey);
      const encrypted2 = await hybridEncrypt("same text", pubKey);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("has correct prefix", async () => {
      const { publicKey } = await generateKeyPair();
      const pubKey = await importPublicKey(publicKey);

      const encrypted = await hybridEncrypt("test", pubKey);
      expect(encrypted.startsWith("hyb:1:")).toBe(true);
    });

    it("fails with wrong private key", async () => {
      const pair1 = await generateKeyPair();
      const pair2 = await generateKeyPair();

      const pubKey = await importPublicKey(pair1.publicKey);
      const wrongPrivKey = await importPrivateKey(pair2.privateKey);

      const encrypted = await hybridEncrypt("secret", pubKey);
      await expect(hybridDecrypt(encrypted, wrongPrivKey)).rejects.toThrow();
    });

    it("throws on invalid format", async () => {
      const { privateKey } = await generateKeyPair();
      const privKey = await importPrivateKey(privateKey);

      await expect(hybridDecrypt("invalid", privKey)).rejects.toThrow(
        "Invalid hybrid encrypted data format",
      );
    });

    it("throws on wrong number of parts", async () => {
      const { privateKey } = await generateKeyPair();
      const privKey = await importPrivateKey(privateKey);

      await expect(hybridDecrypt("hyb:1:only:two", privKey)).rejects.toThrow(
        "Invalid hybrid encrypted data format: wrong number of parts",
      );
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
