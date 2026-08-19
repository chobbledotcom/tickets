import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getAdminFeatureUsage,
  setAdminFeatureEnabled,
} from "#db/admin-features.ts";
import { execute, queryOne } from "#db/client.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { parseEnabledFeatures } from "#shared/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  SEEDED_FEATURE_RECORDS,
  seedFeatureRecords,
  settingValue,
} from "#test-utils/settings.ts";

const storedFeatures = async () =>
  parseEnabledFeatures(await settingValue(CONFIG_KEYS.ENABLED_FEATURES));

const storeDisabledFeatures = async (): Promise<void> => {
  await setAdminFeatureEnabled("site", false);
};

describeWithEnv("db > admin features", { db: true, triggers: true }, () => {
  test("reports every feature unused in an empty database", async () => {
    expect(await getAdminFeatureUsage()).toEqual({
      apiKeys: false,
      attributes: false,
      logistics: false,
      modifiers: false,
      money: false,
      questions: false,
      servicing: false,
      site: false,
    });
  });

  test("finds every feature with saved records in one usage result", async () => {
    await seedFeatureRecords(false);

    expect(await getAdminFeatureUsage()).toEqual({
      apiKeys: true,
      attributes: true,
      logistics: false,
      modifiers: true,
      money: false,
      questions: true,
      servicing: true,
      site: false,
    });
  });

  test("record inserts enable every feature backed by saved data", async () => {
    await seedFeatureRecords();

    expect(await storedFeatures()).toEqual(SEEDED_FEATURE_RECORDS);
  });

  test("record updates enable their matching features", async () => {
    await execute("INSERT INTO attributes (name) VALUES ('Before')");
    await execute(
      "INSERT INTO questions (text, display_type) VALUES ('Before?', 'radio')",
    );
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Before', 'fixed', 1, 'increase')",
    );
    await execute("INSERT INTO logistics_agents (name) VALUES ('Before')");
    await execute(
      "INSERT INTO attendees (created, kind) VALUES ('2026-07-15', 'servicing')",
    );
    await execute(
      "INSERT INTO listings (created, max_attendees) VALUES ('2026-07-15', 10)",
    );
    await execute("UPDATE settings SET value = ? WHERE key = ?", [
      JSON.stringify(parseEnabledFeatures("")),
      CONFIG_KEYS.ENABLED_FEATURES,
    ]);

    await execute("UPDATE attributes SET name = 'After'");
    await execute("UPDATE questions SET text = 'After?'");
    await execute("UPDATE modifiers SET name = 'After'");
    await execute("UPDATE logistics_agents SET name = 'After'");
    await execute("UPDATE attendees SET pii_blob = 'after'");
    await execute("UPDATE listings SET uses_logistics = 1");

    expect(await storedFeatures()).toEqual({
      apiKeys: false,
      attributes: true,
      logistics: true,
      modifiers: true,
      money: false,
      questions: true,
      servicing: true,
      site: false,
    });
  });

  test("ordinary attendees and listings do not enable optional features", async () => {
    await storeDisabledFeatures();
    await execute(
      "INSERT INTO attendees (created, kind) VALUES ('2026-07-15', 'attendee')",
    );
    await execute(
      "INSERT INTO listings (created, max_attendees, uses_logistics) VALUES ('2026-07-15', 10, 0)",
    );

    expect((await storedFeatures()).servicing).toBe(false);
    expect((await storedFeatures()).logistics).toBe(false);
  });

  test("updating an ordinary attendee does not enable Servicing", async () => {
    await storeDisabledFeatures();
    await execute(
      "INSERT INTO attendees (created, kind) VALUES ('2026-07-15', 'attendee')",
    );

    await execute("UPDATE attendees SET pii_blob = 'after'");

    expect((await storedFeatures()).servicing).toBe(false);
  });

  test("updating an ordinary listing does not enable Logistics", async () => {
    await storeDisabledFeatures();
    await execute(
      "INSERT INTO listings (created, max_attendees, uses_logistics) VALUES ('2026-07-15', 10, 0)",
    );

    await execute("UPDATE listings SET uses_logistics = 0");

    expect((await storedFeatures()).logistics).toBe(false);
  });

  test("counts a logistics agent as logistics use", async () => {
    await execute("INSERT INTO logistics_agents (name) VALUES ('Van')");
    expect((await getAdminFeatureUsage()).logistics).toBe(true);
  });

  test("counts a logistics listing as logistics use", async () => {
    await execute(
      "INSERT INTO listings (created, max_attendees, uses_logistics) VALUES ('2026-07-15', 10, 1)",
    );
    expect((await getAdminFeatureUsage()).logistics).toBe(true);
  });

  test("enables one feature without changing the others", async () => {
    await setAdminFeatureEnabled("modifiers", true);
    expect(settings.features).toEqual({
      apiKeys: false,
      attributes: false,
      logistics: false,
      modifiers: true,
      money: false,
      questions: false,
      servicing: false,
      site: false,
    });
    const stored = await settingValue(CONFIG_KEYS.ENABLED_FEATURES);
    expect(stored.startsWith("{")).toBe(true);
    expect(JSON.parse(stored)).toEqual(settings.features);
  });

  test("keeps both features when two enables overlap", async () => {
    await Promise.all([
      setAdminFeatureEnabled("money", true),
      setAdminFeatureEnabled("modifiers", true),
    ]);
    expect(settings.features).toEqual({
      apiKeys: false,
      attributes: false,
      logistics: false,
      modifiers: true,
      money: true,
      questions: false,
      servicing: false,
      site: false,
    });
  });

  test("bumps the settings version when a feature changes", async () => {
    await setAdminFeatureEnabled("money", true);
    const before = Number(await settingValue(CONFIG_KEYS.SETTINGS_VERSION));
    await setAdminFeatureEnabled("money", false);
    const after = Number(await settingValue(CONFIG_KEYS.SETTINGS_VERSION));
    expect(after).toBe(before + 1);
    expect(settings.features.money).toBe(false);
  });

  test("does not bump the settings version when the feature choice already matches", async () => {
    await setAdminFeatureEnabled("money", true);
    const before = await settingValue(CONFIG_KEYS.SETTINGS_VERSION);

    expect(await setAdminFeatureEnabled("money", true)).toBe(true);
    expect(await settingValue(CONFIG_KEYS.SETTINGS_VERSION)).toBe(before);
  });

  test("syncs a Logistics disable into the feature caches", async () => {
    await setAdminFeatureEnabled("money", true);
    await setAdminFeatureEnabled("logistics", true);
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.ENABLED_FEATURES]);

    await setAdminFeatureEnabled("logistics", false);

    const stored = await settingValue(CONFIG_KEYS.ENABLED_FEATURES);
    expect(settings.getCachedRaw(CONFIG_KEYS.ENABLED_FEATURES)).toBe(stored);
    expect(settings.features).toEqual({
      apiKeys: false,
      attributes: false,
      logistics: false,
      modifiers: false,
      money: true,
      questions: false,
      servicing: false,
      site: false,
    });
  });

  test("syncs cleaned Logistics defaults into the snapshot", async () => {
    await settings.update.listingDefaults({
      hidden: true,
      usesLogistics: true,
    });
    await setAdminFeatureEnabled("logistics", true);

    await setAdminFeatureEnabled("logistics", false);

    expect(settings.listingDefaults).toEqual({ hidden: true });
  });

  test("does not disable a feature that has saved records", async () => {
    await setAdminFeatureEnabled("modifiers", true);
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
    );

    expect(await setAdminFeatureEnabled("modifiers", false)).toBe(false);
    expect((await storedFeatures()).modifiers).toBe(true);
  });

  test("re-enables a feature when its first record arrives after disable", async () => {
    await setAdminFeatureEnabled("modifiers", true);
    expect(await setAdminFeatureEnabled("modifiers", false)).toBe(true);
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
    );

    expect(
      parseEnabledFeatures(await settingValue(CONFIG_KEYS.ENABLED_FEATURES))
        .modifiers,
    ).toBe(true);
  });

  test("rejects malformed stored feature JSON after a field write", async () => {
    await execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [CONFIG_KEYS.ENABLED_FEATURES, '{"money":false}'],
    );

    await expect(setAdminFeatureEnabled("money", true)).rejects.toThrow(
      "Stored value does not match its schema",
    );
  });

  test("rolls back a feature record when the stored feature setting is incomplete", async () => {
    await execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [CONFIG_KEYS.ENABLED_FEATURES, '{"attributes":false}'],
    );

    await expect(
      execute("INSERT INTO attributes (name) VALUES ('Level')"),
    ).rejects.toThrow("enabled feature setting is invalid");
    expect(
      await queryOne("SELECT id FROM attributes WHERE name = 'Level'"),
    ).toBeNull();
  });

  test("rolls back Logistics cleanup when the stored feature setting is incomplete", async () => {
    await settings.update.listingDefaults({
      hidden: true,
      usesLogistics: true,
    });
    const defaultsBefore = await settingValue(CONFIG_KEYS.LISTING_DEFAULTS);
    const featuresBefore = '{"logistics":true}';
    await execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [CONFIG_KEYS.ENABLED_FEATURES, featuresBefore],
    );

    await expect(setAdminFeatureEnabled("logistics", false)).rejects.toThrow(
      "Stored value does not match its schema",
    );
    expect(await settingValue(CONFIG_KEYS.LISTING_DEFAULTS)).toBe(
      defaultsBefore,
    );
    expect(await settingValue(CONFIG_KEYS.ENABLED_FEATURES)).toBe(
      featuresBefore,
    );
  });
});
