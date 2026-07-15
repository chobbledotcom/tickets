import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createWithAdminFeature,
  ensureAdminFeatureEnabled,
  getAdminFeatureUsage,
  setAdminFeatureEnabled,
} from "#shared/db/admin-features.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const settingValue = async (key: string): Promise<string> => {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  if (!row) throw new Error(`Setting ${key} was not stored`);
  return row.value;
};

describeWithEnv("db > admin features", { db: true }, () => {
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
    await execute("INSERT INTO attributes (name) VALUES ('Level')");
    await execute(
      "INSERT INTO questions (text, display_type) VALUES ('Notes?', 'free_text')",
    );
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
    );
    await execute(
      "INSERT INTO api_keys (user_id, key_index, wrapped_data_key, name, created) VALUES (1, 'index', 'key', 'Sync', '2026-07-15')",
    );
    await execute(
      "INSERT INTO attendees (created, kind) VALUES ('2026-07-15', 'servicing')",
    );

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
    await ensureAdminFeatureEnabled("modifiers");
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
      ensureAdminFeatureEnabled("money"),
      ensureAdminFeatureEnabled("modifiers"),
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

  test("does not write when a feature is already enabled", async () => {
    await ensureAdminFeatureEnabled("money");
    const before = await settingValue(CONFIG_KEYS.SETTINGS_VERSION);
    await ensureAdminFeatureEnabled("money");
    expect(await settingValue(CONFIG_KEYS.SETTINGS_VERSION)).toBe(before);
  });

  test("bumps the settings version when a feature changes", async () => {
    await setAdminFeatureEnabled("money", true);
    const before = Number(await settingValue(CONFIG_KEYS.SETTINGS_VERSION));
    await setAdminFeatureEnabled("money", false);
    const after = Number(await settingValue(CONFIG_KEYS.SETTINGS_VERSION));
    expect(after).toBe(before + 1);
    expect(settings.features.money).toBe(false);
  });

  test("does not disable a feature that has saved records", async () => {
    await setAdminFeatureEnabled("modifiers", true);
    await execute(
      "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
    );

    expect(await setAdminFeatureEnabled("modifiers", false)).toBe(false);
    expect(settings.features.modifiers).toBe(true);
  });

  test("keeps a feature enabled when disabling overlaps its first save", async () => {
    await setAdminFeatureEnabled("modifiers", true);

    await createWithAdminFeature("modifiers", async () => {
      expect(await setAdminFeatureEnabled("modifiers", false)).toBe(true);
      await execute(
        "INSERT INTO modifiers (name, calc_kind, calc_value, direction) VALUES ('Fee', 'fixed', 1, 'increase')",
      );
    });

    expect(settings.features.modifiers).toBe(true);
  });

  test("enables the feature before its wrapped save starts", async () => {
    await createWithAdminFeature("money", () => {
      expect(settings.features.money).toBe(true);
      return Promise.resolve();
    });
  });

  test("rejects malformed stored feature JSON after a field write", async () => {
    await execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
      [CONFIG_KEYS.ENABLED_FEATURES, '{"money":false}'],
    );

    await expect(setAdminFeatureEnabled("money", true)).rejects.toThrow(
      "Every admin feature must have an enabled value",
    );
  });
});
