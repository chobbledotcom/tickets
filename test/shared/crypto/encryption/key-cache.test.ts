/**
 * The two key caches, and the large-payload path that uses the second one.
 *
 * Small values are sealed straight from the raw key bytes, so nothing under
 * 64KB ever imports a CryptoKey — which is why the CryptoKey cache needs
 * payloads over that size to be observed at all. Both caches must hand back the
 * same key every time, and both must be dropped the moment the key changes, or
 * work would keep being sealed under a key the app has already replaced.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  decryptBytes,
  encryptBytes,
  getEncryptionKeyBytes,
  getEncryptionKeyString,
  setEncryptionKeyForTest,
} from "#shared/crypto/encryption.ts";
import { toBase64 } from "#shared/crypto/utils.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";

/** Over the 64KB limit, so these go through Web Crypto and import a key. */
const bigPayload = (): Uint8Array =>
  Uint8Array.from({ length: 70 * 1024 }, (_, index) => index % 256);

const otherKey = (): string =>
  toBase64(new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>);

describeWithEnv("the encryption key caches", { encryptionKey: true }, () => {
  describe("the raw key bytes", () => {
    it("hand back the very same bytes each time, not a fresh copy", () => {
      // Same instance, so callers holding the bytes cannot drift apart — and
      // the decode is genuinely paid only once.
      expect(getEncryptionKeyBytes()).toBe(getEncryptionKeyBytes());
    });

    it("are a different set of bytes once the key changes", () => {
      const before = getEncryptionKeyBytes();
      setEncryptionKeyForTest(otherKey());
      expect(getEncryptionKeyBytes()).not.toBe(before);
      setupTestEncryptionKey();
    });
  });

  describe("reading the key string", () => {
    it("prefers the test override over the environment", () => {
      using _env = withEnv({ DB_ENCRYPTION_KEY: otherKey() });
      setEncryptionKeyForTest(otherKey());
      expect(getEncryptionKeyString()).toBe(otherKey());
      setupTestEncryptionKey();
    });

    it("treats an empty override as no key, rather than falling back to the environment", () => {
      // An override of "" means "no key" deliberately: falling through to a
      // real environment key here would silently encrypt under a key the
      // caller just cleared.
      using _env = withEnv({ DB_ENCRYPTION_KEY: otherKey() });
      setEncryptionKeyForTest("");
      expect(() => getEncryptionKeyString()).toThrow(
        "DB_ENCRYPTION_KEY environment variable is required",
      );
      setupTestEncryptionKey();
    });
  });

  describe("the imported CryptoKey", () => {
    it("seals and reads back a payload too big for the fast path", async () => {
      const data = bigPayload();
      expect([...(await decryptBytes(await encryptBytes(data)))]).toEqual([
        ...data,
      ]);
    });

    it("is imported once, however many big payloads are sealed", async () => {
      // A fresh key means neither cache is warm from an earlier test.
      setEncryptionKeyForTest(otherKey());
      const realImportKey = crypto.subtle.importKey.bind(crypto.subtle);
      const counted = stub(
        crypto.subtle,
        "importKey",
        realImportKey as typeof crypto.subtle.importKey,
      );
      try {
        await encryptBytes(bigPayload());
        await encryptBytes(bigPayload());
        expect(counted.calls.length).toBe(1);
      } finally {
        counted.restore();
        setupTestEncryptionKey();
      }
    });

    it("is dropped when the key changes, so old big payloads stop opening", async () => {
      const sealed = await encryptBytes(bigPayload());
      setEncryptionKeyForTest(otherKey());
      await expect(decryptBytes(sealed)).rejects.toThrow();
      setupTestEncryptionKey();
    });
  });
});
