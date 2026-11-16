import { getDb } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { modifierRevenueDropFixture } from "#test-utils/db/legacy-aggregate-migration.ts";
import {
  readModifierAggregates as modifierAggregates,
  runAggregateColumnDropTests,
} from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertModifier } from "#test-utils/modifiers.ts";

const { contribution, runMigration } = modifierRevenueDropFixture;

describeWithEnv(
  "db > migrations > 2026-06-22_drop_modifiers_total_revenue",
  { db: true, triggers: true },
  () => {
    runAggregateColumnDropTests({
      contribution,
      createSubject: () => insertModifier(),
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
