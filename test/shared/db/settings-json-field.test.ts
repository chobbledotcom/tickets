import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { execute, queryOnePrimary } from "#shared/db/client.ts";
import { booleanJsonField } from "#shared/db/settings/json-field.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const emptyFeatures = serializeEnabledFeatures(parseEnabledFeatures(""));
const enabledMoneyFeatures = serializeEnabledFeatures(
  setFeatureEnabled(parseEnabledFeatures(""), "money", true),
);

const writeFeatureBoolean = (
  initialValue: string,
  path: string,
  value: boolean,
  whenSql: string,
): Promise<string | null> =>
  booleanJsonField(
    CONFIG_KEYS.ENABLED_FEATURES,
    initialValue,
    path,
    value,
  ).write(whenSql, parseEnabledFeatures);

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
    const enabled = await writeFeatureBoolean(
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
    const disabled = await writeFeatureBoolean(
      emptyFeatures,
      "$.money",
      false,
      "TRUE",
    );
    if (disabled === null) throw new Error("Feature disable was blocked");
    expect(parseEnabledFeatures(disabled).money).toBe(false);
    expect(settings.features.money).toBe(false);
    expect(await settingsVersion()).toBe(beforeDisable + 1);

    const reenabled = await writeFeatureBoolean(
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
      await writeFeatureBoolean(emptyFeatures, "$.site", true, "FALSE"),
    ).toBeNull();
    expect(
      await queryOnePrimary("SELECT value FROM settings WHERE key = ?", [
        CONFIG_KEYS.ENABLED_FEATURES,
      ]),
    ).toBeNull();
  });

  test("rolls back the JSON change when its settings version write fails", async () => {
    await writeFeatureBoolean(emptyFeatures, "$.money", false, "TRUE");
    await execute(`
      CREATE TRIGGER fail_settings_version
      BEFORE INSERT ON settings
      WHEN NEW.key = '${CONFIG_KEYS.SETTINGS_VERSION}'
      BEGIN
        SELECT RAISE(ABORT, 'version write failed');
      END
    `);
    try {
      await expect(
        writeFeatureBoolean(enabledMoneyFeatures, "$.money", true, "TRUE"),
      ).rejects.toThrow("version write failed");
    } finally {
      await execute("DROP TRIGGER IF EXISTS fail_settings_version");
    }
    const stored = await queryOnePrimary<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [CONFIG_KEYS.ENABLED_FEATURES],
    );
    expect(parseEnabledFeatures(stored!.value).money).toBe(false);
  });
});
