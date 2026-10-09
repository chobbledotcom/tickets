import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { decryptWithKey, encryptWithKey } from "#crypto/encryption.ts";
import {
  deriveKEK,
  deriveKEKFromPassword,
  generateDataKey,
  unwrapKey,
  unwrapKeyWithToken,
  wrapDataKeyForPassword,
  wrapKey,
  wrapKeyWithToken,
} from "#crypto/keys.ts";
import type { PasswordHash, WrappedKey } from "#crypto/sealed.ts";
import { generateSecureToken } from "#crypto/utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// Two stored-password-hash stand-ins. The v2 KEK folds the account's password
// hash into its salt, so these stand in for two different users' hashes.
// Hand-crafted stored values — test fixture casts. This file exercises the
// crypto helpers directly, so the inline `as PasswordHash` / `as WrappedKey`
// literals below are likewise deliberate fake inputs.
const HASH_A = "pbkdf2:1000:c2FsdEE=:aGFzaEE=" as PasswordHash;
const HASH_B = "pbkdf2:1000:c2FsdEI=:aGFzaEI=" as PasswordHash;

describeWithEnv("KEK derivation", { encryptionKey: true }, () => {
  it("derives a usable CryptoKey", async () => {
    // Hand-crafted stored password hash — test fixture cast.
    const passwordHash = "pbkdf2:1000:c2FsdA==:aGFzaA==" as PasswordHash;
    const kek = await deriveKEK(passwordHash);
    expect(kek).toBeDefined();
    expect(kek.type).toBe("secret");
  });

  it("produces same key for same inputs", async () => {
    // Hand-crafted stored password hash — test fixture cast.
    const passwordHash = "pbkdf2:1000:c2FsdA==:aGFzaA==" as PasswordHash;
    const kek1 = await deriveKEK(passwordHash);
    const kek2 = await deriveKEK(passwordHash);

    // Wrap/unwrap with each to verify they're equivalent
    const dataKey = await generateDataKey();
    const wrapped1 = await wrapKey(dataKey, kek1);
    const unwrapped = await unwrapKey(wrapped1, kek2);
    expect(unwrapped).toBeDefined();
  });

  it("produces different keys for different password hashes", async () => {
    const kek1 = await deriveKEK("hash1" as PasswordHash);
    const kek2 = await deriveKEK("hash2" as PasswordHash);

    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, kek1);

    // Should fail to unwrap with different KEK
    await expect(unwrapKey(wrapped, kek2)).rejects.toThrow();
  });

  it("deriveKEKFromPassword round-trips a data key", async () => {
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(
      dataKey,
      await deriveKEKFromPassword("hunter2", HASH_A),
    );
    const unwrapped = await unwrapKey(
      wrapped,
      await deriveKEKFromPassword("hunter2", HASH_A),
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
      await deriveKEKFromPassword("same-string", HASH_A),
    );
    await expect(
      unwrapKey(wrappedV2, await deriveKEK("same-string" as PasswordHash)),
    ).rejects.toThrow();
  });

  it("deriveKEKFromPassword produces different keys for different passwords", async () => {
    // Same per-user hash, different password → the password alone must change
    // the KEK, so the v2 wrap is bound to the secret and not just the salt.
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(
      dataKey,
      await deriveKEKFromPassword("pw-one", HASH_A),
    );
    await expect(
      unwrapKey(wrapped, await deriveKEKFromPassword("pw-two", HASH_A)),
    ).rejects.toThrow();
  });

  it("deriveKEKFromPassword is salted per user: same password, different hash", async () => {
    // Per-user salt: two accounts that happen to share a password still get
    // distinct KEKs, so cracking one wrap doesn't unwrap everyone's DATA_KEY.
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(
      dataKey,
      await deriveKEKFromPassword("shared-pw", HASH_A),
    );
    await expect(
      unwrapKey(wrapped, await deriveKEKFromPassword("shared-pw", HASH_B)),
    ).rejects.toThrow();
  });

  it("wrapDataKeyForPassword wraps so only the password's KEK unwraps", async () => {
    const dataKey = await generateDataKey();
    const wrapped = await wrapDataKeyForPassword(dataKey, "s3cret", HASH_A);
    const unwrapped = await unwrapKey(
      wrapped,
      await deriveKEKFromPassword("s3cret", HASH_A),
    );
    const encrypted = await encryptWithKey("ok", dataKey);
    expect(await decryptWithKey(encrypted, unwrapped)).toBe("ok");
  });
});

describeWithEnv("key wrapping", { encryptionKey: true }, () => {
  describe("wrapKey and unwrapKey", () => {
    it("round-trips a data key", async () => {
      const dataKey = await generateDataKey();
      const kek = await deriveKEK("test-hash" as PasswordHash);

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
      const kek = await deriveKEK("test-hash" as PasswordHash);
      const wrapped = await wrapKey(dataKey, kek);
      expect(wrapped.startsWith("wk:1:")).toBe(true);
    });

    it("throws on invalid format", async () => {
      const kek = await deriveKEK("test-hash" as PasswordHash);
      await expect(unwrapKey("invalid" as WrappedKey, kek)).rejects.toThrow(
        "Invalid wrapped key format",
      );
    });

    it("throws on missing IV separator", async () => {
      const kek = await deriveKEK("test-hash" as PasswordHash);
      await expect(
        unwrapKey("wk:1:nocoIon" as WrappedKey, kek),
      ).rejects.toThrow("Invalid wrapped key format: missing IV separator");
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
        unwrapKeyWithToken("invalid-data" as WrappedKey, sessionToken),
      ).rejects.toThrow("Invalid wrapped key format");
    });

    it("throws on invalid wrapped key format (missing IV separator)", async () => {
      const sessionToken = generateSecureToken();
      await expect(
        unwrapKeyWithToken("wk:1:nodatahere" as WrappedKey, sessionToken),
      ).rejects.toThrow("Invalid wrapped key format: missing IV separator");
    });
  });
});
