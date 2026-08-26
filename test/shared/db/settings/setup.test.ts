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
import {
  deriveKEKFromPassword,
  importPrivateKey,
  unwrapKey,
} from "#crypto/keys.ts";
import type { KeyEncrypted, WrappedKey } from "#crypto/sealed.ts";
import { getDb } from "#db/client.ts";
import { SetupAlreadyCompleteError } from "#db/settings/setup.ts";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import { getUserByUsername, verifyUserPassword } from "#db/users.ts";
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
});
