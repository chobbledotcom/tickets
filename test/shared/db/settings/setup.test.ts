/**
 * The one-time setup ceremony must run exactly once.
 *
 * `completeSetup` writes the owner account, the wrapped DATA_KEY, and the
 * keypair that protects every attendee's PII. A second ceremony that got
 * through would overwrite the stored keypair, and the first owner would hold a
 * wrapped key for a data key the site no longer uses — a sign-in that reads
 * nothing. `claimSetupSlot` makes the whole ceremony hang off one conditional
 * write, so these tests pin that claim.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decryptWithKey } from "#crypto/encryption.ts";
import { importPrivateKey } from "#crypto/hybrid.ts";
import { deriveKEKFromPassword, unwrapKey } from "#crypto/keys.ts";

import type { KeyEncrypted, PasswordHash, WrappedKey } from "#crypto/sealed.ts";
import { getDb } from "#db/client.ts";
import { SetupAlreadyCompleteError } from "#db/settings/setup.ts";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import {
  createUser,
  getUserByUsername,
  verifyUserPassword,
} from "#db/users.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const emptySite = async (): Promise<void> => {
  await getDb().execute("DELETE FROM users");
  await getDb().execute("DELETE FROM settings");
  settings.setup.clearCache();
  settings.invalidateCache();
};

const ownerCount = async (): Promise<number> =>
  Number(
    (await getDb().execute("SELECT COUNT(*) AS total FROM users")).rows[0]!
      .total,
  );

/** Proves the stored keypair is the one this owner's password unlocks. */
const ownerCanReadSiteData = async (
  username: string,
  password: string,
): Promise<boolean> => {
  const user = await getUserByUsername(username);
  if (user === null) throw new Error(`Owner ${username} was not created`);
  const passwordHash = await verifyUserPassword(user, password);
  if (!passwordHash) throw new Error(`Owner ${username} rejected its password`);
  const kek = await deriveKEKFromPassword(password, passwordHash);
  const dataKey = await unwrapKey(user.wrapped_data_key as WrappedKey, kek);
  const privateKey = await decryptWithKey(
    settings.wrappedPrivateKey as KeyEncrypted,
    dataKey,
  );
  await importPrivateKey(privateKey);
  return true;
};

describeWithEnv("db > settings > setup ceremony", { db: true }, () => {
  describe("a finished ceremony", () => {
    test("leaves a new site with the welcome message on", async () => {
      await emptySite();
      await settings.setup.complete("owner-one", "firstpassword", "GB");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.welcomeEnabled).toBe(true);
    });
  });

  describe("a second ceremony", () => {
    test("is refused once the first one finished", async () => {
      await emptySite();
      await settings.setup.complete("owner-one", "firstpassword", "GB");
      settings.setup.clearCache();
      settings.invalidateCache();

      await expect(
        settings.setup.complete("owner-two", "secondpassword", "US"),
      ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);
      expect(await ownerCount()).toBe(1);
    });

    test("leaves the first owner's country and keypair untouched", async () => {
      await emptySite();
      await settings.setup.complete("owner-one", "firstpassword", "GB");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      const firstPublicKey = settings.publicKey;

      await expect(
        settings.setup.complete("owner-two", "secondpassword", "US"),
      ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);

      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.publicKey).toBe(firstPublicKey);
      expect(settings.country).toBe("GB");
      expect(await getUserByUsername("owner-two")).toBeNull();
    });
  });

  describe("two ceremonies started together", () => {
    test("let exactly one through and refuse the other", async () => {
      await emptySite();
      const results = await Promise.allSettled([
        settings.setup.complete("racer-one", "firstpassword", "GB"),
        settings.setup.complete("racer-two", "secondpassword", "US"),
      ]);

      const refused = results.filter((r) => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.reason).toBeInstanceOf(SetupAlreadyCompleteError);
      expect(await ownerCount()).toBe(1);
    });

    test("leave the surviving owner able to read the site's data", async () => {
      await emptySite();
      const passwords = new Map([
        ["racer-one", "firstpassword"],
        ["racer-two", "secondpassword"],
      ]);
      await Promise.allSettled([
        settings.setup.complete("racer-one", "firstpassword", "GB"),
        settings.setup.complete("racer-two", "secondpassword", "US"),
      ]);
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      expect(await ownerCount()).toBe(1);
      const survivor =
        (await getUserByUsername("racer-one")) === null
          ? "racer-two"
          : "racer-one";
      expect(
        await ownerCanReadSiteData(survivor, passwords.get(survivor)!),
      ).toBe(true);
    });
  });

  describe("the first ceremony", () => {
    test("completeSetup sets all config values and generates key hierarchy", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM settings");
      await settings.setup.complete("setupuser", "mypassword", "US");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      expect(await settings.setup.isComplete()).toBe(true);
      const user = await getUserByUsername("setupuser");
      expect(user).not.toBeNull();
      const hash = await verifyUserPassword(user!, "mypassword");
      expect(hash).toBeTruthy();
      expect(hash).toContain("pbkdf2:");
      expect(settings.currency).toBe("USD");

      expect(settings.publicKey).toBeTruthy();
      expect(user!.wrapped_data_key).toBeTruthy();
      expect(settings.wrappedPrivateKey).toBeTruthy();
    });

    test("completeSetup clears stale pre-setup settings cache and confirms setup", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM settings");
      settings.setup.clearCache();
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.wrappedPrivateKey).toBe("");
      expect(settings.publicKey).toBe("");
      expect(await settings.setup.isComplete()).toBe(false);

      await settings.setup.complete("setupuser", "mypassword", "US");

      expect(await settings.setup.isComplete()).toBe(true);
      expect(settings.wrappedPrivateKey).toBe("");
      expect(settings.publicKey).toBe("");
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(settings.wrappedPrivateKey).toBeTruthy();
      expect(settings.publicKey).toBeTruthy();
      expect(settings.country).toBe("US");
      expect(settings.currency).toBe("USD");
    });

    test("completeSetup rolls back every write when the owner insert fails", async () => {
      await getDb().execute("DELETE FROM users");
      await getDb().execute("DELETE FROM settings");
      // Pre-seed a user whose username collides with the owner-to-be, so the
      // owner INSERT violates the unique username index and aborts the batch.
      // Hand-crafted stored hash — test fixture cast.
      await createUser(
        "ownerdupe",
        "pbkdf2:seedhash" as PasswordHash,
        null,
        "manager",
      );
      settings.setup.clearCache();
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(await settings.setup.isComplete()).toBe(false);

      await expect(
        settings.setup.complete("ownerdupe", "mypassword", "US"),
      ).rejects.toThrow();

      // The whole ceremony rolled back: no config keys, no setup flag, and the
      // colliding owner row was never created (still just the seeded user).
      settings.setup.clearCache();
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);
      expect(await settings.setup.isComplete()).toBe(false);
      expect(settings.publicKey).toBe("");
      expect(settings.wrappedPrivateKey).toBe("");
      const count = await getDb().execute("SELECT COUNT(*) AS n FROM users");
      expect(Number(count.rows[0]!.n)).toBe(1);
    });

    test("isComplete reloads cache when it has expired", async () => {
      settings.invalidateCache();
      const result = await settings.setup.isComplete();
      expect(result).toBe(true);
    });
  });
});
