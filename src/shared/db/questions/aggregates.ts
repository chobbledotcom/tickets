/**
 * Answer-selection aggregates and modifier links.
 *
 * `answers.times_selected` is a trigger-maintained total that the owner can
 * also edit manually (and recalculate from `attendee_answers` when it drifts).
 * The `modifier_id` column links an answer to the price modifier it triggers.
 */

import { map } from "#fp";
import {
  execute,
  queryAll,
  queryOne,
  requireOne,
  resetAggregates,
} from "#shared/db/client.ts";
import type {
  AggregateRecalculation,
  AggregateValues,
} from "#shared/db/common-schema.ts";

/** The owner-editable, trigger-maintained aggregate columns on an answer. */
export const ANSWER_AGGREGATE_FIELDS = ["times_selected"] as const;

export type AnswerAggregateField = (typeof ANSWER_AGGREGATE_FIELDS)[number];

export type AnswerAggregateValues = AggregateValues<AnswerAggregateField>;

export type AnswerAggregateRecalculation =
  AggregateRecalculation<AnswerAggregateField>;

/** The stored selection total (times_selected) for every answer of a question,
 * keyed by answer id. Reads the trigger-maintained column directly rather than
 * scanning attendee_answers, so the question detail page is a single row read. */
export const getAnswerSelectionTotals = async (
  questionId: number,
): Promise<Map<number, number>> => {
  const rows = await queryAll<{ id: number; times_selected: number }>(
    "SELECT id, times_selected FROM answers WHERE question_id = ?",
    [questionId],
  );
  return new Map(
    map(
      ({ id, times_selected }: { id: number; times_selected: number }) =>
        [id, times_selected] as const,
    )(rows),
  );
};

/** The answer's stored times_selected together with the value it would hold if
 * rebuilt from attendee_answers, so the edit page can flag (and the recalculate
 * flow can repair) a drifted aggregate. */
export const getAnswerAggregateRecalculation = async (
  answerId: number,
): Promise<AnswerAggregateRecalculation> => {
  const row = await requireOne<{ current: number; recalculated: number }>(
    `SELECT times_selected AS current,
            (SELECT COUNT(*) FROM attendee_answers WHERE answer_id = answers.id)
              AS recalculated
     FROM answers WHERE id = ?`,
    [answerId],
  );
  return {
    times_selected: { current: row.current, recalculated: row.recalculated },
  };
};

/** Manually set an answer's editable aggregate from the edit form. */
export const updateAnswerAggregateValues = async (
  answerId: number,
  values: AnswerAggregateValues,
): Promise<void> => {
  await execute("UPDATE answers SET times_selected = ? WHERE id = ?", [
    values.times_selected,
    answerId,
  ]);
};

const answerAggregateResetSql: Record<AnswerAggregateField, string> = {
  times_selected:
    "times_selected = COALESCE((SELECT COUNT(*) FROM attendee_answers WHERE answer_id = ?), 0)",
};

/** Reset selected answer aggregate columns from the actual attendee_answers. */
export const resetAnswerAggregateFields = async (
  answerId: number,
  fields: AnswerAggregateField[],
): Promise<void> => {
  await resetAggregates("answers", answerId, fields, answerAggregateResetSql);
};

/** Get the price-modifier id a single answer triggers, or null when it has
 * none. The modifier_id column isn't part of the decrypted Answer shape, so the
 * answer edit page reads it directly to pre-select the modifier dropdown. */
export const getAnswerModifierId = async (
  answerId: number,
): Promise<number | null> => {
  const row = await queryOne<{ modifier_id: number | null }>(
    "SELECT modifier_id FROM answers WHERE id = ?",
    [answerId],
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
  await execute("UPDATE answers SET modifier_id = ? WHERE id = ?", [
    modifierId,
    answerId,
  ]);
};
