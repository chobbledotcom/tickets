/**
 * The intermediate state issue #2288 dies in: a site that ran a build with
 * 2026-07-26_payment_records but not 2026-08-10_refund_authority_records.
 * The chain suites cannot see it — restoreSchemaBeforeMigrations drops each
 * pending migration's objects, so the first apply recreates every payment
 * table in its final shape and no intermediate apply meets a foreign one.
 * Here the dormant tables exist in the shape the intermediate build deployed.
 */

import { assert, assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { loadMigrations } from "#db/migrations/context.ts";
import { paymentTables } from "#db/migrations/schema/payments/index.ts";
import {
  createTableSql,
  verifyCurrentAppSchema,
} from "#db/migrations/schema-sync.ts";
import { initDb, invalidateInitDbCache } from "#db/migrations.ts";
import {
  markAppliedThrough,
  markSchemaMarkersStale,
  restoreSchemaBeforeMigrations,
  tableColumns,
} from "#test/integration/db/migration-restore/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { appliedMigrationIds } from "#test-utils/migrations.ts";

const MIGRATIONS = await loadMigrations();

/**
 * The dormant tables the refund redefinition left alone. It rebuilt only
 * payment_charges, so the current declaration is also the shape the
 * intermediate build deployed for these five.
 */
const UNCHANGED_DORMANT_TABLES = [
  "payment_sessions",
  "payment_completion_effects",
  "payment_completion_deliveries",
  "payment_cases",
  "payment_case_decisions",
] as const;

/**
 * payment_charges as the intermediate build created it, from the schema that
 * shipped with 2026-07-26_payment_records. The sealed-value CHECK rules are
 * left out — no step in this upgrade reads them. The refund redefinition
 * later dropped payment_id, origin, resource_kind, the pending_refund_*
 * columns, provider_refunded_at and legacy_source, and added refund columns
 * that are NOT NULL with no default, which SQLite refuses to add.
 */
const INTERMEDIATE_PAYMENT_CHARGES_SQL = `CREATE TABLE payment_charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'current',
  provider TEXT,
  resource_kind TEXT,
  provider_reference TEXT NOT NULL,
  reference_index TEXT,
  captured_amount INTEGER,
  currency TEXT,
  refunded_amount INTEGER,
  refund_state TEXT NOT NULL DEFAULT 'none',
  pending_refund_id TEXT,
  pending_refund_index TEXT,
  pending_refund_idempotency_key TEXT,
  pending_refund_key_index TEXT,
  provider_refunded_at INTEGER,
  legacy_source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
)`;

const createDormantTablesInIntermediateShape = async (): Promise<void> => {
  for (const name of UNCHANGED_DORMANT_TABLES) {
    const entry = paymentTables.find(([table]) => table === name)!;
    await getDb().execute(createTableSql(entry));
  }
  await getDb().execute(INTERMEDIATE_PAYMENT_CHARGES_SQL);
};

/** Wind the golden database back to a site stuck on the intermediate build:
 * the schema of 2026-07-26, the dormant tables in their deployed shape, and
 * every later migration recorded as still outstanding. */
const windBackToIntermediateBuild = async (): Promise<void> => {
  const pending = MIGRATIONS.slice(
    MIGRATIONS.findIndex((m) => m.id === "2026-07-26_payment_records") + 1,
  );
  await restoreSchemaBeforeMigrations(pending);
  await createDormantTablesInIntermediateShape();
  await markAppliedThrough("2026-07-26_payment_records");
  await markSchemaMarkersStale();
  invalidateInitDbCache();
};

/** One stored charge, as the intermediate build's own writers left it. */
const storeOneCharge = async (): Promise<void> => {
  await getDb().execute(
    "INSERT INTO payment_charges " +
      "(payment_id, provider_reference, created_at, updated_at, observed_at) " +
      "VALUES ('pay-1', 'sealed-reference', 100, 100, 100)",
  );
};

describeWithEnv(
  "upgrade from the intermediate payment-records build",
  { db: true, triggers: true },
  () => {
    test("reaches the current schema from the deployed intermediate state", async () => {
      await windBackToIntermediateBuild();

      await initDb();

      await verifyCurrentAppSchema();
      const applied = await appliedMigrationIds();
      assertArrayIncludes(applied, ["2026-08-04_login_attempt_stamp"]);
      assertArrayIncludes(applied, ["2026-08-10_refund_authority_records"]);

      // The redefinition replaced the foreign shape: the refund columns it
      // adds are present, and the columns it dropped are gone. An upgrade
      // that only added columns would keep the dropped ones.
      const chargeColumns = await tableColumns("payment_charges");
      expect(chargeColumns.has("refund_state_name")).toBe(true);
      expect(chargeColumns.has("refund_local_state")).toBe(true);
      expect(chargeColumns.has("payment_id")).toBe(false);
      expect(chargeColumns.has("pending_refund_id")).toBe(false);

      expect((await tableColumns("login_attempts")).has("last_attempt")).toBe(
        true,
      );
    });

    test("stops at the documented refusal when the dormant tables hold payment history", async () => {
      await windBackToIntermediateBuild();
      await storeOneCharge();

      // The stamp migration must finish — it owns login_attempts alone, and
      // the foreign payment tables are none of its business. The upgrade then
      // stops at the refusal that names the stored history, not at a SQLite
      // ALTER error an intermediate apply has no business reaching.
      await expect(initDb()).rejects.toThrow(
        "refusing to reinterpret stored payment history",
      );
      assertArrayIncludes(await appliedMigrationIds(), [
        "2026-08-04_login_attempt_stamp",
      ]);
      assert(
        !(await appliedMigrationIds()).includes(
          "2026-08-10_refund_authority_records",
        ),
      );

      const stored = await getDb().execute(
        "SELECT COUNT(*) AS value FROM payment_charges",
      );
      expect(Number(stored.rows[0]!.value)).toBe(1);
    });
  },
);
