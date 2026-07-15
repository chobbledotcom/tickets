import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { getDb, queryOnePrimary } from "#shared/db/client.ts";
import { writeBooleanJsonField } from "#shared/db/settings/json-field.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

const emptyFeatures = serializeEnabledFeatures(parseEnabledFeatures(""));
const enabledMoneyFeatures = serializeEnabledFeatures(
  setFeatureEnabled(parseEnabledFeatures(""), "money", true),
);

const settingsVersion = async (): Promise<number> => {
  const row = await queryOnePrimary<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.SETTINGS_VERSION],
  );
  if (!row) throw new Error("Settings version was not stored");
  return Number(row.value);
};

describeWithEnv("db > settings JSON fields", { db: true }, () => {
  test("writes booleans and syncs the setting snapshot and version", async () => {
    const beforeEnable = await settingsVersion();
    const enabled = await writeBooleanJsonField(
      CONFIG_KEYS.ENABLED_FEATURES,
      enabledMoneyFeatures,
      "$.money",
      true,
      "TRUE",
    );
    if (enabled === null) throw new Error("Feature enable was blocked");
    expect(parseEnabledFeatures(enabled).money).toBe(true);
    expect(settings.features.money).toBe(true);
    expect(await settingsVersion()).toBe(beforeEnable + 1);

    const beforeDisable = await settingsVersion();
    const disabled = await writeBooleanJsonField(
      CONFIG_KEYS.ENABLED_FEATURES,
      emptyFeatures,
      "$.money",
      false,
      "TRUE",
    );
    if (disabled === null) throw new Error("Feature disable was blocked");
    expect(parseEnabledFeatures(disabled).money).toBe(false);
    expect(settings.features.money).toBe(false);
    expect(await settingsVersion()).toBe(beforeDisable + 1);

    const reenabled = await writeBooleanJsonField(
      CONFIG_KEYS.ENABLED_FEATURES,
      enabledMoneyFeatures,
      "$.money",
      true,
      "TRUE",
    );
    if (reenabled === null) throw new Error("Feature re-enable was blocked");
    expect(parseEnabledFeatures(reenabled).money).toBe(true);
  });

  test("does not store a boolean when its condition is false", async () => {
    expect(
      await writeBooleanJsonField(
        CONFIG_KEYS.ENABLED_FEATURES,
        emptyFeatures,
        "$.site",
        true,
        "FALSE",
      ),
    ).toBeNull();
    expect(
      await queryOnePrimary("SELECT value FROM settings WHERE key = ?", [
        CONFIG_KEYS.ENABLED_FEATURES,
      ]),
    ).toBeNull();
  });

  test("does nothing when listing defaults have not been saved", async () => {
    expect(await settings.update.clearListingDefaultUsesLogistics()).toBe(
      false,
    );
  });

  test("does nothing when the Logistics default is already absent", async () => {
    await settings.update.listingDefaults({ hidden: true });
    expect(await settings.update.clearListingDefaultUsesLogistics()).toBe(
      false,
    );
    expect(settings.listingDefaults).toEqual({ hidden: true });
  });

  test("removes the Logistics default and syncs the snapshot and version", async () => {
    await settings.update.listingDefaults({
      hidden: true,
      usesLogistics: true,
    });
    const before = await settingsVersion();

    expect(await settings.update.clearListingDefaultUsesLogistics()).toBe(true);
    expect(settings.listingDefaults).toEqual({ hidden: true });
    expect(await settingsVersion()).toBe(before + 1);
  });

  test("keeps a concurrent listing-default change", async () => {
    await settings.update.listingDefaults({
      hidden: false,
      usesLogistics: true,
    });
    const db = getDb();
    const originalBatch = db.batch.bind(db);
    let changePending = true;
    const batchStub = stub(db, "batch", async (statements, mode) => {
      const results = await originalBatch(statements, mode);
      if (changePending) {
        changePending = false;
        await settings.update.listingDefaults({
          hidden: true,
          minimumDaysBefore: 5,
          usesLogistics: true,
        });
      }
      return results;
    });
    try {
      expect(await settings.update.clearListingDefaultUsesLogistics()).toBe(
        true,
      );
    } finally {
      batchStub.restore();
    }

    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.LISTING_DEFAULTS]);
    expect(settings.listingDefaults).toEqual({
      hidden: true,
      minimumDaysBefore: 5,
    });
  });

  test("fails when the setting keeps changing", async () => {
    await settings.update.listingDefaults({ usesLogistics: true });
    const db = getDb();
    const originalExecute = db.execute.bind(db);
    let updateAttempts = 0;
    const executeStub = stub(db, "execute", (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (!sql.startsWith("UPDATE settings SET value")) {
        return originalExecute(statement);
      }
      updateAttempts += 1;
      return Promise.resolve(emptyResultSet());
    });
    try {
      await expect(
        settings.update.clearListingDefaultUsesLogistics(),
      ).rejects.toThrow("Setting listing_defaults changed too often to update");
    } finally {
      executeStub.restore();
    }
    expect(updateAttempts).toBe(8);
  });
});
