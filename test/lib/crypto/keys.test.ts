import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { decryptWithKey, encryptWithKey } from "#shared/crypto/encryption.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  generateDataKey,
  generateKeyPair,
  hybridDecrypt,
  hybridEncrypt,
  importPrivateKey,
  importPublicKey,
  setRsaKeySizeForTest,
  unwrapKey,
  unwrapKeyWithToken,
  wrapDataKeyForPassword,
  wrapKey,
  wrapKeyWithToken,
} from "#shared/crypto/keys.ts";
import { generateSecureToken } from "#shared/crypto/utils.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("KEK derivation", { encryptionKey: true }, () => {
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

  it("deriveKEKFromPassword round-trips a data key", async () => {
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(
      dataKey,
      await deriveKEKFromPassword("hunter2"),
    );
    const unwrapped = await unwrapKey(
      wrapped,
      await deriveKEKFromPassword("hunter2"),
    );
    const encrypted = await encryptWithKey("payload", dataKey);
    expect(await decryptWithKey(encrypted, unwrapped)).toBe("payload");
  });

  it("deriveKEKFromPassword differs from deriveKEK for the same input", async () => {
    // Domain separation: a v2 (password-derived) wrap can't be unwrapped by the
    // v1 KEK from the same string, so a recovered password hash is useless.
    const dataKey = await generateDataKey();
    const wrappedV2 = await wrapKey(
      dataKey,
      await deriveKEKFromPassword("same-string"),
    );
    await expect(
      unwrapKey(wrappedV2, await deriveKEK("same-string")),
    ).rejects.toThrow();
  });

  it("deriveKEKFromPassword produces different keys for different passwords", async () => {
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(
      dataKey,
      await deriveKEKFromPassword("pw-one"),
    );
    await expect(
      unwrapKey(wrapped, await deriveKEKFromPassword("pw-two")),
    ).rejects.toThrow();
  });

  it("wrapDataKeyForPassword wraps so only the password's KEK unwraps", async () => {
    const dataKey = await generateDataKey();
    const wrapped = await wrapDataKeyForPassword(dataKey, "s3cret");
    const unwrapped = await unwrapKey(
      wrapped,
      await deriveKEKFromPassword("s3cret"),
    );
    const encrypted = await encryptWithKey("ok", dataKey);
    expect(await decryptWithKey(encrypted, unwrapped)).toBe("ok");
  });
});

describeWithEnv("key wrapping", { encryptionKey: true }, () => {
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
  // Generate one shared key pair for tests that just need a valid key pair,
  // avoiding expensive RSA key generation (~300-600ms each at 1024 bits).
  let sharedPair: { publicKey: string; privateKey: string };
  let sharedPubKey: CryptoKey;
  let sharedPrivKey: CryptoKey;

  const ensureSharedKeyPair = async (): Promise<void> => {
    if (sharedPair) return;
    sharedPair = await generateKeyPair();
    sharedPubKey = await importPublicKey(sharedPair.publicKey);
    sharedPrivKey = await importPrivateKey(sharedPair.privateKey);
  };

  describe("generateKeyPair", () => {
    it("generates valid key pair", async () => {
      await ensureSharedKeyPair();
      expect(sharedPair.publicKey).toBeDefined();
      expect(sharedPair.privateKey).toBeDefined();
      expect(JSON.parse(sharedPair.publicKey).kty).toBe("RSA");
      expect(JSON.parse(sharedPair.privateKey).kty).toBe("RSA");
    });

    it("uses production key size when TEST_RSA_KEY_SIZE is unset", async () => {
      setRsaKeySizeForTest(null);
      try {
        const pair = await generateKeyPair();
        const jwk = JSON.parse(pair.publicKey);
        // 2048-bit RSA key: n (modulus) is 256 bytes = 344 base64url chars
        expect(jwk.n.length).toBeGreaterThan(300);
      } finally {
        setRsaKeySizeForTest(1024);
      }
    });

    it("generates different key pairs each time", async () => {
      await ensureSharedKeyPair();
      const pair2 = await generateKeyPair();
      expect(sharedPair.publicKey).not.toBe(pair2.publicKey);
      expect(sharedPair.privateKey).not.toBe(pair2.privateKey);
    });
  });

  describe("hybridEncrypt and hybridDecrypt", () => {
    it("round-trips a simple string", async () => {
      await ensureSharedKeyPair();

      const plaintext = "hello world";
      const encrypted = await hybridEncrypt(plaintext, sharedPubKey);
      const decrypted = await hybridDecrypt(encrypted, sharedPrivKey);
      expect(decrypted).toBe(plaintext);
    });

    it("round-trips unicode and emoji", async () => {
      await ensureSharedKeyPair();

      const plaintext = "こんにちは 🌍 émojis";
      const encrypted = await hybridEncrypt(plaintext, sharedPubKey);
      const decrypted = await hybridDecrypt(encrypted, sharedPrivKey);
      expect(decrypted).toBe(plaintext);
    });

    it("produces different ciphertext for same plaintext", async () => {
      await ensureSharedKeyPair();

      const encrypted1 = await hybridEncrypt("same text", sharedPubKey);
      const encrypted2 = await hybridEncrypt("same text", sharedPubKey);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it("has correct prefix", async () => {
      await ensureSharedKeyPair();

      const encrypted = await hybridEncrypt("test", sharedPubKey);
      expect(encrypted.startsWith("hyb:1:")).toBe(true);
    });

    it("fails with wrong private key", async () => {
      await ensureSharedKeyPair();
      // Need a second key pair to test wrong-key failure
      const pair2 = await generateKeyPair();
      const wrongPrivKey = await importPrivateKey(pair2.privateKey);

      const encrypted = await hybridEncrypt("secret", sharedPubKey);
      await expect(hybridDecrypt(encrypted, wrongPrivKey)).rejects.toThrow();
    });

    it("throws on invalid format", async () => {
      await ensureSharedKeyPair();

      await expect(hybridDecrypt("invalid", sharedPrivKey)).rejects.toThrow(
        "Invalid hybrid encrypted data format",
      );
    });

    it("throws on wrong number of parts", async () => {
      await ensureSharedKeyPair();

      await expect(
        hybridDecrypt("hyb:1:only:two", sharedPrivKey),
      ).rejects.toThrow(
        "Invalid hybrid encrypted data format: wrong number of parts",
      );
    });
  });
});
