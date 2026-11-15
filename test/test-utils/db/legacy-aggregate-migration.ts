import dropListingIncomeMigration from "#db/migrations/2026-06-22_drop_listing_income.ts";
import dropModifiersTotalRevenueMigration from "#db/migrations/2026-06-22_drop_modifiers_total_revenue.ts";
import { recreateTable, syncTriggers } from "#db/migrations/schema-sync.ts";
import type { MigrationBuilder } from "#db/migrations/types.ts";
import { type SqlStatement, sql, sqlName } from "#db/sql.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

/** One aggregate-column drop, and the trigger columns it retired. The usage
 *  row's quantity column is always `quantity`; every other name comes here. */
type LegacyAggregateSpec = {
  readonly migration: MigrationBuilder;
  /** Target table that stores the aggregates. */
  readonly table: string;
  /** Stored total, kept from the usage row's quantity (booked_quantity, total_uses). */
  readonly total: string;
  /** Stored count of usage rows (tickets_count, usage_count). */
  readonly count: string;
  /** Stored money column the migration drops (income, total_revenue). */
  readonly amount: string;
  /** Usage-row money column the stored amount mirrors (price_paid, amount_applied). */
  readonly usageAmount: string;
  /** Usage-row column naming the aggregate row (listing_id, modifier_id). */
  readonly owner: string;
};

/** What one aggregate-column drop test drives. */
type LegacyAggregateFixture = {
  /** The signed `+`/`-` SET clause the pre-drop triggers applied. */
  readonly contribution: (sign: "+" | "-", row: "NEW" | "OLD") => SqlStatement;
  /** Runs the migration's up() against the real client. */
  readonly runMigration: () => Promise<void>;
};

/**
 * Build a drop-migration fixture. The contribution clause lets the fixture
 * mirror a real pre-migration database, whose triggers still name the column
 * the migration removes. The migration's up() touches only recreateTable and
 * syncTriggers here; getDb stays real.
 */
const fixtureFor = (spec: LegacyAggregateSpec): LegacyAggregateFixture => {
  const context = buildMigrationContext({ recreateTable, syncTriggers });
  const contribution = (sign: "+" | "-", row: "NEW" | "OLD"): SqlStatement => {
    const op = sign === "+" ? sql`+` : sql`-`;
    const usageColumn = (column: string): SqlStatement =>
      sqlName(`${row}.${column}`);
    const { total, count, amount } = spec;
    return sql`UPDATE ${sqlName(spec.table)} SET
     ${sqlName(total)} = ${sqlName(total)} ${op} ${usageColumn("quantity")},
     ${sqlName(count)} = ${sqlName(count)} ${op} 1,
     ${sqlName(amount)} = ${sqlName(amount)} ${op} ${usageColumn(spec.usageAmount)}
   WHERE id = ${usageColumn(spec.owner)};`;
  };
  return { contribution, runMigration: () => spec.migration(context).up() };
};

/** The drop of listings.income and its trigger lines. */
export const listingIncomeDropFixture = fixtureFor({
  amount: "income",
  count: "tickets_count",
  migration: dropListingIncomeMigration,
  owner: "listing_id",
  table: "listings",
  total: "booked_quantity",
  usageAmount: "price_paid",
});

/** The drop of modifiers.total_revenue and its trigger lines. */
export const modifierRevenueDropFixture = fixtureFor({
  amount: "total_revenue",
  count: "usage_count",
  migration: dropModifiersTotalRevenueMigration,
  owner: "modifier_id",
  table: "modifiers",
  total: "total_uses",
  usageAmount: "amount_applied",
});
