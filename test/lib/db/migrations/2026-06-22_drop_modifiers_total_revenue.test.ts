import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import dropModifiersTotalRevenueMigration from "#shared/db/migrations/2026-06-22_drop_modifiers_total_revenue.ts";
import {
  recreateTable,
  syncTriggers,
} from "#shared/db/migrations/schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  MigrationContext,
  SchemaRequirement,
} from "#shared/db/migrations/types.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { describeWithEnv } from "#test-utils";

// Promise<never> so one stub satisfies both the void- and boolean-returning
// context members; this migration's up() touches only the three below.
const unused = async (): Promise<never> => {
  throw new Error("unused migration context member called");
};

const context: MigrationContext = {
  additive: (migration: AdditiveMigration): Migration => ({
    ...migration,
    verify: async () => {},
  }),
  applySchemaChanges: unused,
  backfillAnswerAggregates: unused,
  backfillListingAggregates: unused,
  backfillModifierAggregates: unused,
  ensureDefaultAttendeeStatus: unused,
  getDb,
  recreateTable,
  renameEventsToListings: unused,
  syncCurrentSchema: unused,
  syncIndexes: unused,
  syncTriggers,
  tableExists: unused,
  verifyCurrentAppSchema: unused,
  verifyRequirement: (_req: SchemaRequirement) => async () => {},
};

const runMigration = () => dropModifiersTotalRevenueMigration(context).up();

const AGGREGATE_TRIGGERS = [
  "trg_modifier_usages_aggregates_insert",
  "trg_modifier_usages_aggregates_delete",
  "trg_modifier_usages_aggregates_update",
];

/** The old revenue-maintaining SET clause (signed `+`/`-`) the pre-drop triggers
 *  used, so the fixture mirrors a real pre-migration database whose triggers
 *  still reference the total_revenue column. */
const contribution = (sign: "+" | "-", row: "NEW" | "OLD"): string =>
  `UPDATE modifiers SET
     total_uses = total_uses ${sign} ${row}.quantity,
     usage_count = usage_count ${sign} 1,
     total_revenue = total_revenue ${sign} ${row}.amount_applied
   WHERE id = ${row}.modifier_id;`;

/** Recreate the legacy revenue-maintaining triggers (dropped by the migration). */
const installLegacyTriggers = async (): Promise<void> => {
  const bodies: Record<string, string> = {
    trg_modifier_usages_aggregates_delete: `AFTER DELETE ON modifier_usages
FOR EACH ROW BEGIN
  ${contribution("-", "OLD")}
END`,
    trg_modifier_usages_aggregates_insert: `AFTER INSERT ON modifier_usages
FOR EACH ROW BEGIN
  ${contribution("+", "NEW")}
END`,
    trg_modifier_usages_aggregates_update: `AFTER UPDATE OF quantity, amount_applied, modifier_id ON modifier_usages
FOR EACH ROW BEGIN
  ${contribution("-", "OLD")}
  ${contribution("+", "NEW")}
END`,
  };
  for (const name of AGGREGATE_TRIGGERS) {
    await getDb().execute(`DROP TRIGGER IF EXISTS ${name}`);
    await getDb().execute(`CREATE TRIGGER ${name} ${bodies[name]}`);
  }
};

/** Build the pre-migration state: the total_revenue column restored and the
 *  legacy revenue-maintaining triggers in place (as a production DB had before
 *  drop). */
const seedPreDropSchema = async (): Promise<void> => {
  await getDb().execute(
    "ALTER TABLE modifiers ADD COLUMN total_revenue INTEGER NOT NULL DEFAULT 0",
  );
  await installLegacyTriggers();
};

const modifierColumns = async (): Promise<string[]> => {
  const result = await getDb().execute("PRAGMA table_info(modifiers)");
  return result.rows.map((row) => String(row.name));
};

const triggerNames = async (): Promise<Set<string>> => {
  const result = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'",
  );
  return new Set(result.rows.map((row) => String(row.name)));
};

const modifierCounts = async (
  modifierId: number,
): Promise<{ total_uses: number; usage_count: number }> => {
  const result = await getDb().execute({
    args: [modifierId],
    sql: "SELECT total_uses, usage_count FROM modifiers WHERE id = ?",
  });
  const row = result.rows[0]!;
  return {
    total_uses: Number(row.total_uses),
    usage_count: Number(row.usage_count),
  };
};

const makeModifier = () =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Add-on",
  });

describeWithEnv(
  "db > migrations > 2026-06-22_drop_modifiers_total_revenue",
  { db: true, triggers: true },
  () => {
    test("drops the total_revenue column from modifiers", async () => {
      await seedPreDropSchema();
      expect(await modifierColumns()).toContain("total_revenue");
      await runMigration();
      expect(await modifierColumns()).not.toContain("total_revenue");
    });

    test("keeps the three aggregate triggers in place", async () => {
      await seedPreDropSchema();
      await runMigration();
      const triggers = await triggerNames();
      for (const name of AGGREGATE_TRIGGERS) {
        expect(triggers.has(name)).toBe(true);
      }
    });

    test("rebuilt triggers still maintain the counts without a revenue column", async () => {
      // Create the modifier before restoring the total_revenue column, so the
      // app's ledger-based read (which projects its own total_revenue) isn't run
      // against a table that also carries a stored total_revenue column.
      const modifier = await makeModifier();
      await seedPreDropSchema();
      await runMigration();

      // The legacy triggers referenced total_revenue; if the migration had not
      // replaced them, this insert would fail on the now-missing column.
      await getDb().execute({
        args: [modifier.id],
        sql: "INSERT INTO modifier_usages (modifier_id, attendee_id, quantity, amount_applied, created) VALUES (?, 1, 3, 1500, '2026-06-22')",
      });

      expect(await modifierCounts(modifier.id)).toEqual({
        total_uses: 3,
        usage_count: 1,
      });
    });
  },
);
