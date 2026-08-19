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
} from "#crypto/encryption.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey, withEnv } from "#test-utils/env.ts";
import {
  OTHER_TEST_ENCRYPTION_KEY,
  TEST_ENCRYPTION_KEY,
} from "#test-utils/internal.ts";

/** Over the 64KB limit, so these go through Web Crypto and import a key. */
const bigPayload = (): Uint8Array =>
  Uint8Array.from({ length: 70 * 1024 }, (_, index) => index % 256);

describeWithEnv("the encryption key caches", { encryptionKey: true }, () => {
  describe("the raw key bytes", () => {
    it("hand back the very same bytes each time, not a fresh copy", () => {
      // Handing back one instance is the whole point of the cache: it is what
      // keeps the decode off every encrypt on a cold-booting edge isolate.
      // Nothing else distinguishes a working cache from a missing one, so this
      // is the assertion that would notice it being dropped.
      expect(getEncryptionKeyBytes()).toBe(getEncryptionKeyBytes());
    });

    it("are a different set of bytes once the key changes", () => {
      const before = getEncryptionKeyBytes();
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      expect(getEncryptionKeyBytes()).not.toBe(before);
      setupTestEncryptionKey();
    });
  });

  describe("reading the key string", () => {
    it("prefers the test override over the environment", () => {
      // Two different valid keys, so the answer says which one was read.
      using _env = withEnv({ DB_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY });
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      expect(getEncryptionKeyString()).toBe(OTHER_TEST_ENCRYPTION_KEY);
      setupTestEncryptionKey();
    });

    it("treats an empty override as no key, rather than falling back to the environment", () => {
      // An override of "" means "no key" deliberately: falling through to a
      // real environment key here would silently encrypt under a key the
      // caller just cleared.
      using _env = withEnv({ DB_ENCRYPTION_KEY: OTHER_TEST_ENCRYPTION_KEY });
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
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
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
      setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
      await expect(decryptBytes(sealed)).rejects.toThrow();
      setupTestEncryptionKey();
    });
  });
});
