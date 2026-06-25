import { getDb } from "#shared/db/client.ts";
import dropModifiersTotalRevenueMigration from "#shared/db/migrations/2026-06-22_drop_modifiers_total_revenue.ts";
import {
  recreateTable,
  syncTriggers,
} from "#shared/db/migrations/schema-sync.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { buildMigrationContext, describeWithEnv } from "#test-utils";
import {
  readModifierAggregates as modifierAggregates,
  runAggregateColumnDropTests,
} from "../migration-test-helpers.ts";

// This migration's up() touches only the three below — recreateTable and
// syncTriggers do the trigger/structure rebuild; getDb is real by default.
const context = buildMigrationContext({ recreateTable, syncTriggers });

const runMigration = () => dropModifiersTotalRevenueMigration(context).up();

/** Old revenue-maintaining SET clause (signed `+`/`-`) the pre-drop triggers
 *  used, so the fixture mirrors a real pre-migration database whose triggers
 *  still reference the total_revenue column. */
const contribution = (sign: "+" | "-", row: "NEW" | "OLD"): string =>
  `UPDATE modifiers SET
     total_uses = total_uses ${sign} ${row}.quantity,
     usage_count = usage_count ${sign} 1,
     total_revenue = total_revenue ${sign} ${row}.amount_applied
   WHERE id = ${row}.modifier_id;`;

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
    runAggregateColumnDropTests({
      contribution,
      createSubject: makeModifier,
      dropColumn: "total_revenue",
      dropColumnPhrase: "a revenue",
      expected: { total_uses: 3, usage_count: 1 },
      insertUsage: (modifierId) =>
        getDb().execute({
          args: [modifierId],
          sql: "INSERT INTO modifier_usages (modifier_id, attendee_id, quantity, amount_applied, created) VALUES (?, 1, 3, 1500, '2026-06-22')",
        }),
      readAggregates: modifierAggregates,
      runMigration,
      targetTable: "modifiers",
      triggerStem: "trg_modifier_usages_aggregates",
      updateOfColumns: ["quantity", "amount_applied", "modifier_id"],
      usageTable: "modifier_usages",
    });
  },
);
