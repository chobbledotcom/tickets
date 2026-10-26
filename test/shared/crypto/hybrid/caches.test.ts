/** How the hybrid crypto caches behave: what the cache registry exposes,
 * when a repeat read is served from a cache, and what a key change wipes. */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { describe, it } from "@std/testing/bdd";
import { setEncryptionKeyForTest } from "#crypto/encryption.ts";
import {
  generateKeyPair,
  getPrivateKeyFromSession,
  hybridDecrypt,
  hybridEncrypt,
  importPrivateKey,
  importPublicKey,
  setRsaKeySizeForTest,
} from "#crypto/hybrid.ts";
import type { WrappedKey } from "#crypto/sealed.ts";
import { settings } from "#db/settings.ts";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { OTHER_TEST_ENCRYPTION_KEY } from "#test-utils/internal.ts";
import { getTestAuthSession } from "#test-utils/session.ts";

/** Spin until the wall clock leaves the current millisecond: the TTL maths
 * only tells a cache hit from a recompute once the clock has moved. */
const waitClockTick = (): void => {
  const start = Date.now();
  while (Date.now() === start) {
    // No test sleeps for real, so spin out the one millisecond instead.
  }
};

/** The entry count one named cache reports to the cache registry. */
const statEntries = (name: string): number | undefined =>
  getAllCacheStats().find((stat) => stat.name === name)?.entries;

/** The session's private key, the way the request path hands the arguments
 * over. An unset stored key is a loud failure, not a silent skip. */
const sessionPrivateKeyFor = async (
  token: string,
  wrappedDataKey: WrappedKey,
): Promise<CryptoKey> => {
  const wrappedPrivateKey = settings.wrappedPrivateKey;
  if (!wrappedPrivateKey) throw new Error("no wrapped private key stored");
  return getPrivateKeyFromSession(token, wrappedDataKey, wrappedPrivateKey);
};

describe("hybrid crypto caches", () => {
  it("names its two caches in the cache registry", () => {
    const names = getAllCacheStats().map((stat) => stat.name);
    expect(names).toContain("decrypt");
    expect(names).toContain("privateKeys");
  });

  it("refuses an RSA key size of zero", async () => {
    setRsaKeySizeForTest(0);
    try {
      await expect(generateKeyPair()).rejects.toThrow();
    } finally {
      setRsaKeySizeForTest(1024);
    }
  });

  describeWithEnv(
    "with a database and an encryption key",
    { db: true, encryptionKey: true },
    () => {
      let publicKey: string;
      let privateKey: CryptoKey;

      const ensureKeyPair = async (): Promise<void> => {
        if (publicKey) return;
        const pair = await generateKeyPair();
        publicKey = pair.publicKey;
        privateKey = await importPrivateKey(pair.privateKey);
      };

      const ownerPublicKey = async (): Promise<CryptoKey> => {
        await ensureKeyPair();
        return importPublicKey(publicKey);
      };

      it("caches a decrypt result under its ciphertext", async () => {
        const sealed = await hybridEncrypt(
          "count me",
          await ownerPublicKey(),
        );
        const before = statEntries("decrypt") ?? 0;
        await hybridDecrypt(sealed, privateKey);
        expect(statEntries("decrypt")).toBe(before + 1);
      });

      it("serves a repeat decrypt of one ciphertext without repeating the RSA work", async () => {
        const sealed = await hybridEncrypt(
          "cache me",
          await ownerPublicKey(),
        );
        expect(await hybridDecrypt(sealed, privateKey)).toBe("cache me");
        const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        const counted = stub(
          crypto.subtle,
          "decrypt",
          realDecrypt as typeof crypto.subtle.decrypt,
        );
        try {
          waitClockTick();
          expect(await hybridDecrypt(sealed, privateKey)).toBe("cache me");
          expect(counted.calls.length).toBe(0);
        } finally {
          counted.restore();
        }
      });

      it("wipes the decrypt cache when the encryption key changes", async () => {
        const sealed = await hybridEncrypt(
          "wipe me",
          await ownerPublicKey(),
        );
        await hybridDecrypt(sealed, privateKey);
        expect(statEntries("decrypt")).toBeGreaterThan(0);
        setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
        expect(statEntries("decrypt")).toBe(0);
        setupTestEncryptionKey();
      });

      it("serves one session's private key from the cache across a clock tick", async () => {
        const session = await getTestAuthSession();
        const first = await sessionPrivateKeyFor(
          session.token,
          session.wrappedDataKey as WrappedKey,
        );
        waitClockTick();
        const second = await sessionPrivateKeyFor(
          session.token,
          session.wrappedDataKey as WrappedKey,
        );
        expect(second).toBe(first);
      });

      it("wipes the session key cache when the encryption key changes", async () => {
        const session = await getTestAuthSession();
        await sessionPrivateKeyFor(
          session.token,
          session.wrappedDataKey as WrappedKey,
        );
        expect(statEntries("privateKeys")).toBeGreaterThan(0);
        setEncryptionKeyForTest(OTHER_TEST_ENCRYPTION_KEY);
        expect(statEntries("privateKeys")).toBe(0);
        setupTestEncryptionKey();
      });
    },
  );
});
