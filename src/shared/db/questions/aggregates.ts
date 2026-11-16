/**
 * Answer-selection aggregates and modifier links.
 *
 * `answers.times_selected` is a trigger-maintained total that the owner can
 * also edit manually (and recalculate from `attendee_answers` when it drifts).
 * The `modifier_id` column links an answer to the price modifier it triggers.
 */

import { execute, queryOne, requireOne } from "#db/client.ts";
import {
  type AggregateRecalculation,
  type AggregateValues,
  aggregateRepairs,
} from "#db/common-schema.ts";
import { records } from "#db/record-table.ts";
import { onReplicaAndPrimary } from "#db/replica-or-primary.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { sql } from "#db/sql.ts";
import { update } from "#db/write.ts";
import { fieldById } from "#fp";

/** The owner-editable, trigger-maintained aggregate columns on an answer. */
export const ANSWER_AGGREGATE_FIELDS = ["times_selected"] as const;

export type AnswerAggregateField = (typeof ANSWER_AGGREGATE_FIELDS)[number];

export type AnswerAggregateValues = AggregateValues<AnswerAggregateField>;

export type AnswerAggregateRecalculation =
  AggregateRecalculation<AnswerAggregateField>;

/** The stored selection total (times_selected) for every answer of the given
 * questions, keyed by answer id. Reads the trigger-maintained column directly
 * rather than scanning attendee_answers. One query covers a question list, so
 * the admin API answers each answer's total without a read per question. The
 * primary version serves the answer a write just made: a lagging replica does
 * not hold that row, so its total has no value. */
export const {
  onPrimary: getAnswerSelectionTotalsOnPrimary,
  onReplica: getAnswerSelectionTotals,
} = onReplicaAndPrimary(
  (questionIds: number[]) =>
    from(tables.answers)
      .where({ question_id: questionIds })
      .pick("id", "times_selected"),
  fieldById("times_selected"),
);

/** The answer's stored times_selected together with the value it would hold if
 * rebuilt from attendee_answers, so the edit page can flag (and the recalculate
 * flow can repair) a drifted aggregate. */
export const getAnswerAggregateRecalculation = async (
  answerId: number,
): Promise<AnswerAggregateRecalculation> => {
  const row = await requireOne<{ current: number; recalculated: number }>(
    sql`SELECT times_selected AS current,
            (SELECT COUNT(*) FROM attendee_answers WHERE answer_id = answers.id)
              AS recalculated
     FROM answers WHERE id = ${answerId}`,
  );
  return {
    times_selected: { current: row.current, recalculated: row.recalculated },
  };
};

/** Write the operator's typed selection total, or rebuild it from the actual
 * attendee_answers rows. */
export const answerAggregates = aggregateRepairs(tables.answers, {
  times_selected: sql`COALESCE((SELECT COUNT(*) FROM attendee_answers WHERE answer_id = answers.id), 0)`,
});

/** Get the price-modifier id a single answer triggers, or null when it has
 * none. The modifier_id column isn't part of the decrypted Answer shape, so the
 * answer edit page reads it directly to pre-select the modifier dropdown. */
export const getAnswerModifierId = async (
  answerId: number,
): Promise<number | null> => {
  const row = await queryOne(
    records.answers.byId(answerId).pick("modifier_id"),
  );
  return row?.modifier_id ?? null;
};

/** Point a single answer at an "answer"-trigger modifier, or clear the link
 * (null). The inverse of setModifierAnswers, driven from the answer's own edit
 * page so an answer carries at most one modifier. */
export const setAnswerModifier = async (
  answerId: number,
  modifierId: number | null,
): Promise<void> => {
  await execute(
    update(tables.answers, { modifier_id: modifierId }).where({ id: answerId }),
  );
};
