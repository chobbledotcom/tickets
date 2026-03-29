import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { setEncryptionKeyForTest } from "#lib/crypto/encryption.ts";
import {
  computeTicketTokenIndex,
  hashPassword,
  hashSessionToken,
  hmacHash,
  verifyPassword,
} from "#lib/crypto/hashing.ts";
import {
  describeWithEnv,
  setTestEnv,
  setupTestEncryptionKey,
} from "#test-utils";

describe("password hashing", () => {
  describe("hashPassword", () => {
    it("generates different hashes for same password (random salt)", async () => {
      const hash1 = await hashPassword("samepassword");
      const hash2 = await hashPassword("samepassword");
      expect(hash1).not.toBe(hash2);
    });

    it("uses production iterations when test override is disabled", async () => {
      const restore = setTestEnv({ TEST_FAST_PBKDF2: undefined });
      try {
        const hash = await hashPassword("password");
        const iterations = Number(hash.split(":")[1]);
        expect(iterations).toBe(600000);
      } finally {
        restore();
      }
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

    it("returns false for hash with empty parts", async () => {
      const result = await verifyPassword("password", "pbkdf2:::");
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

describeWithEnv("hmacHash", { encryptionKey: true }, () => {
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

    // Change the encryption key via module override (avoids env var races)
    const altKey = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTY=";
    setEncryptionKeyForTest(altKey);

    const hash2 = await hmacHash(ip);
    expect(hash1).not.toBe(hash2);

    // Restore original key
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

describeWithEnv("computeTicketTokenIndex", { encryptionKey: true }, () => {
  it("is an alias for hmacHash", async () => {
    const token = "ABC1234567";
    const index = await computeTicketTokenIndex(token);
    const hash = await hmacHash(token);
    expect(index).toBe(hash);
  });
});
