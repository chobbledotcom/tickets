import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  ensureAdminFeatureEnabled,
  getAdminFeatureUsage,
} from "#shared/db/admin-features.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > admin features", { db: true }, () => {
  test("reports every feature unused in an empty database", async () => {
    expect(await getAdminFeatureUsage()).toEqual({
      apiKeys: false,
      logistics: false,
      modifiers: false,
      money: false,
      servingEvents: false,
    });
  });

  test("finds modifiers, API keys, and serving events in one usage result", async () => {
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
      logistics: false,
      modifiers: true,
      money: false,
      servingEvents: true,
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
    expect(settings.enabledFeatures).toEqual({
      apiKeys: false,
      logistics: false,
      modifiers: true,
      money: false,
      servingEvents: false,
    });
    const row = await queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      [CONFIG_KEYS.ENABLED_FEATURES],
    );
    if (!row) throw new Error("enabled_features was not stored");
    expect(row.value.startsWith("{")).toBe(true);
    expect(JSON.parse(row.value)).toEqual(settings.enabledFeatures);
  });

  test("does not write when the feature is already enabled", async () => {
    await settings.update.enabledFeatures({
      ...settings.enabledFeatures,
      modifiers: true,
    });
    const before = settings.version;
    await ensureAdminFeatureEnabled("modifiers");
    expect(settings.version).toBe(before);
  });
});
