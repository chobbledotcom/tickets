/** RSA key pair generation and hybrid encryption pins, moved beside
 *  src/shared/crypto/hybrid.ts with the section they exercise. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  generateKeyPair,
  hybridDecrypt,
  hybridEncrypt,
  importPrivateKey,
  importPublicKey,
  setRsaKeySizeForTest,
} from "#crypto/hybrid.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";

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
  describe("imported keys", () => {
    it("cannot be exported back out of the browser's crypto", async () => {
      await ensureSharedKeyPair();
      // A private key that could be exported could be copied out of memory by
      // any later code holding it, so both keys are imported non-extractable.
      expect(sharedPrivKey.extractable).toBe(false);
      expect(sharedPubKey.extractable).toBe(false);
    });

    it("refuses an export attempt", async () => {
      await ensureSharedKeyPair();
      await expect(
        crypto.subtle.exportKey("jwk", sharedPrivKey),
      ).rejects.toThrow();
    });
  });

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

      await expect(
        hybridDecrypt("invalid" as OwnerKeyEncrypted, sharedPrivKey),
      ).rejects.toThrow("Invalid hybrid encrypted data format");
    });

    it("throws on wrong number of parts", async () => {
      await ensureSharedKeyPair();

      await expect(
        hybridDecrypt("hyb:1:only:two" as OwnerKeyEncrypted, sharedPrivKey),
      ).rejects.toThrow(
        "Invalid hybrid encrypted data format: wrong number of parts",
      );
    });
  });
});
