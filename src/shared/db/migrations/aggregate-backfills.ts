/**
 * The cached aggregate columns a migration recomputes once, from the child
 * rows that feed them. The triggers keep them current afterwards.
 */

import { getDb } from "#db/client.ts";
import { type SqlStatement, sql, sqlCommas, sqlName } from "#db/sql.ts";

/** One cached aggregate column, and the child query that recomputes it. */
type CachedAggregate = {
  readonly column: string;
  /** A query over the child rows that reads the parent row by name. */
  readonly from: SqlStatement;
};

/**
 * Recompute cached parent aggregates from their child rows. The write is
 * absolute, so a re-run gives the same result.
 */
const recomputeAggregates =
  (parent: string, aggregates: readonly CachedAggregate[]) =>
  async (): Promise<void> => {
    const sets = aggregates.map(
      ({ column, from }) => sql`${sqlName(column)} = COALESCE((${from}), 0)`,
    );
    await getDb().execute(
      sql`UPDATE ${sqlName(parent)} SET ${sqlCommas(sets)}`,
    );
  };

/**
 * Recompute the modifiers aggregate columns from modifier_usages. The
 * triggers keep them current after the migration. A re-run gives the same
 * result, because the write is absolute.
 */
export const backfillModifierAggregates = recomputeAggregates("modifiers", [
  {
    column: "total_uses",
    from: sql`SELECT SUM(quantity) FROM modifier_usages
            WHERE modifier_id = modifiers.id`,
  },
  {
    column: "usage_count",
    from: sql`SELECT COUNT(*) FROM modifier_usages
            WHERE modifier_id = modifiers.id`,
  },
]);

/**
 * Recompute the answers.times_selected aggregate from attendee_answers. The
 * triggers keep it current after the migration. A re-run gives the same
 * result, because the write is absolute.
 */
export const backfillAnswerAggregates = recomputeAggregates("answers", [
  {
    column: "times_selected",
    from: sql`SELECT COUNT(*) FROM attendee_answers
            WHERE answer_id = answers.id`,
  },
]);
