import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import invoicesFeature from "#db/migrations/2026-11-04_invoices_feature.ts";
import { CONFIG_KEYS } from "#db/settings.ts";
import {
  parseEnabledFeatures,
  serializeEnabledFeatures,
  setFeatureEnabled,
} from "#shared/admin-features.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext();
const runMigration = (): Promise<void> => invoicesFeature(context).up();

const storedFeatures = async (): Promise<unknown> => {
  const row = await queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [CONFIG_KEYS.ENABLED_FEATURES],
  );
  if (!row) throw new Error("enabled_features is missing");
  return JSON.parse(row.value);
};

/** Store a setting as a site that predates the Invoices switch wrote it. */
const storeBeforeInvoices = async (): Promise<void> => {
  const { invoices: _invoices, ...before } = parseEnabledFeatures("");
  await execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
    CONFIG_KEYS.ENABLED_FEATURES,
    JSON.stringify(before),
  ]);
};

describeWithEnv(
  "db > migrations > 2026-11-04_invoices_feature",
  { db: true },
  () => {
    test("adds the Invoices switch and keeps every earlier choice", async () => {
      await storeBeforeInvoices();
      await execute(
        "UPDATE settings SET value = json_set(value, '$.money', json('true')) WHERE key = ?",
        [CONFIG_KEYS.ENABLED_FEATURES],
      );

      await runMigration();

      expect(await storedFeatures()).toEqual({
        ...parseEnabledFeatures(""),
        money: true,
      });
    });

    test("enables Invoices for a site that already sent one", async () => {
      await storeBeforeInvoices();
      await execute(
        "INSERT INTO invoices (attendee_id, body, created, share_token, share_token_index) VALUES (1, 'enc:1:a', '2026-11-04T09:00:00.000Z', 'hyb:1:a', 'index-a')",
      );

      await runMigration();

      expect(await storedFeatures()).toEqual({
        ...parseEnabledFeatures(""),
        invoices: true,
      });
    });

    test("keeps an explicit Invoices choice when it runs again", async () => {
      await execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [
          CONFIG_KEYS.ENABLED_FEATURES,
          serializeEnabledFeatures(
            setFeatureEnabled(parseEnabledFeatures(""), "invoices", false),
          ),
        ],
      );
      await execute(
        "INSERT INTO invoices (attendee_id, body, created, share_token, share_token_index) VALUES (1, 'enc:1:a', '2026-11-04T09:00:00.000Z', 'hyb:1:a', 'index-a')",
      );

      await runMigration();
      await runMigration();

      expect(await storedFeatures()).toEqual(parseEnabledFeatures(""));
    });
  },
);
