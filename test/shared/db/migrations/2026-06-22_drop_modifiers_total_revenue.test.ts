import { getDb } from "#db/client.ts";
import { insertRow } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { modifierRevenueDropFixture } from "#test-utils/db/legacy-aggregate-migration.ts";
import {
  readModifierAggregates as modifierAggregates,
  runAggregateColumnDropTests,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const { contribution, runMigration } = modifierRevenueDropFixture;

const makeModifier = () =>
  insertRow(tables.modifiers, {
    calc_kind: "fixed",
    calc_value: 5,
    direction: "charge",
    name: "Add-on",
  });

describeWithEnv(
  "db > migrations > 2026-06-22_drop_modifiers_total_revenue",
  { db: true, triggers: true },
  () => {
    runAggregateColumnDropTests({
      contribution,
      createSubject: makeModifier,
      dropColumn: "total_revenue",
      dropColumnPhrase: "a revenue",
      expected: { total_uses: 3, usage_count: 1 },
      insertUsage: (modifierId) =>
        getDb().execute(
          sql`INSERT INTO modifier_usages (modifier_id, attendee_id, quantity, amount_applied, created) VALUES (${modifierId}, 1, 3, 1500, '2026-06-22')`,
        ),
      readAggregates: modifierAggregates,
      runMigration,
      targetTable: "modifiers",
      triggerStem: "trg_modifier_usages_aggregates",
      updateOfColumns: ["quantity", "amount_applied", "modifier_id"],
      usageTable: "modifier_usages",
    });
  },
);
