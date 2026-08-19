/**
 * What a key change invalidates on the small-value path, and in the caches
 * sibling modules register through onEncryptionKeyChange. Values at or below
 * 64KB are sealed straight from the raw key bytes; the CryptoKey the larger
 * path imports is covered in key-cache.test.ts.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  decrypt,
  encrypt,
  getEncryptionKeyBytes,
  setEncryptionKeyForTest,
} from "#crypto/encryption.ts";
import {
  decryptWithOwnerKey,
  encryptWithOwnerKey,
  generateKeyPair,
  importPrivateKey,
} from "#crypto/keys.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { OTHER_TEST_ENCRYPTION_KEY } from "#test-utils/internal.ts";

describeWithEnv("changing the encryption key", { encryptionKey: true }, () => {
  describe("the cached key bytes", () => {
    it("follow the new key rather than the key they were read under", () => {
      const before = [...getEncryptionKeyBytes()];
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      expect([...getEncryptionKeyBytes()]).not.toEqual(before);
      setupTestEncryptionKey();
    });

    it("come back to the original key when it is set again", () => {
      const original = [...getEncryptionKeyBytes()];
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      setupTestEncryptionKey();
      expect([...getEncryptionKeyBytes()]).toEqual(original);
    });
  });

  describe("sealing and opening small values", () => {
    it("cannot read back work sealed under the previous key", async () => {
      const sealed = await encrypt("secret");
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      await expect(decrypt(sealed)).rejects.toThrow();
      setupTestEncryptionKey();
    });

    it("seals new work under the new key, readable after the change", async () => {
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      const sealed = await encrypt("secret");
      expect(await decrypt(sealed)).toBe("secret");
      setupTestEncryptionKey();
    });

    it("can read work sealed before the change once the key is back", async () => {
      const sealed = await encrypt("secret");
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      setupTestEncryptionKey();
      expect(await decrypt(sealed)).toBe("secret");
    });
  });

  describe("caches other modules register", () => {
    it("clears the owner-key cache, so a wrong key can no longer open a value", async () => {
      const owner = await generateKeyPair();
      const sealed = await encryptWithOwnerKey("a note", owner.publicKey);
      const ownerPrivate = await importPrivateKey(owner.privateKey);
      // Reading it once puts the plaintext in the shared cache.
      expect(await decryptWithOwnerKey(sealed, ownerPrivate)).toBe("a note");

      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);

      // With the cache cleared this has to do the real work, and the wrong
      // private key cannot do it. A surviving entry would hand back the note.
      const stranger = await generateKeyPair();
      const strangerPrivate = await importPrivateKey(stranger.privateKey);
      await expect(
        decryptWithOwnerKey(sealed, strangerPrivate),
      ).rejects.toThrow();
      setupTestEncryptionKey();
    });
  });
});
