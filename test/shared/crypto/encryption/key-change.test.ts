/**
 * What changing the encryption key must invalidate.
 *
 * Both resolved keys are cached — the CryptoKey used by the Web Crypto paths
 * and the raw bytes used by the node:crypto fast paths — and sibling modules
 * hang their own caches off `onEncryptionKeyChange`. If any of that survived a
 * key change, work would keep being sealed under the old key while the app
 * reported the new one, so each cache is proven stale-free through observable
 * behaviour rather than by reading the cache.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  decrypt,
  encrypt,
  getEncryptionKeyBytes,
  onEncryptionKeyChange,
  setEncryptionKeyForTest,
} from "#shared/crypto/encryption.ts";
import { toBase64 } from "#shared/crypto/utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";

/** A second valid 32-byte key, distinct from the harness's own. */
const otherKey = (): string =>
  toBase64(new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>);

describeWithEnv("changing the encryption key", { encryptionKey: true }, () => {
  describe("the cached key bytes", () => {
    it("follow the new key rather than the key they were read under", () => {
      const before = [...getEncryptionKeyBytes()];
      setEncryptionKeyForTest(otherKey());
      expect([...getEncryptionKeyBytes()]).not.toEqual(before);
      setupTestEncryptionKey();
    });

    it("come back to the original key when it is set again", () => {
      const original = [...getEncryptionKeyBytes()];
      setEncryptionKeyForTest(otherKey());
      setupTestEncryptionKey();
      expect([...getEncryptionKeyBytes()]).toEqual(original);
    });
  });

  describe("the cached CryptoKey", () => {
    it("cannot read back work sealed under the previous key", async () => {
      const sealed = await encrypt("secret");
      setEncryptionKeyForTest(otherKey());
      // The old ciphertext must now fail: if the CryptoKey cache had survived
      // the change, this would still decrypt happily.
      await expect(decrypt(sealed)).rejects.toThrow();
      setupTestEncryptionKey();
    });

    it("seals new work under the new key, readable after the change", async () => {
      setEncryptionKeyForTest(otherKey());
      const sealed = await encrypt("secret");
      expect(await decrypt(sealed)).toBe("secret");
      setupTestEncryptionKey();
    });

    it("can read work sealed before the change once the key is back", async () => {
      const sealed = await encrypt("secret");
      setEncryptionKeyForTest(otherKey());
      setupTestEncryptionKey();
      expect(await decrypt(sealed)).toBe("secret");
    });
  });

  describe("caches registered by other modules", () => {
    it("are told every time the key changes", () => {
      let told = 0;
      onEncryptionKeyChange(() => told++);
      setEncryptionKeyForTest(otherKey());
      expect(told).toBe(1);
      setupTestEncryptionKey();
      expect(told).toBe(2);
    });

    it("are all told, not just the first one registered", () => {
      const told: string[] = [];
      onEncryptionKeyChange(() => told.push("first"));
      onEncryptionKeyChange(() => told.push("second"));
      setEncryptionKeyForTest(otherKey());
      expect(told).toEqual(["first", "second"]);
      setupTestEncryptionKey();
    });
  });
});
