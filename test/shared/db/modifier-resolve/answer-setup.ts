/**
 * Shared setup for the answer-trigger suites in this folder: create a
 * question with answers, hang an answer-triggered modifier off them, and
 * resolve a one-item cart where each listed listing picked answers.
 */

import {
  answerModifierQuantities,
  resolveModifiers,
} from "#db/modifier-resolve.ts";
import { type ModifierInput, setModifierAnswers } from "#db/modifiers.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { checkoutItem } from "#test-utils/checkout.ts";
import { insertModifier, patchModifier } from "#test-utils/modifiers.ts";

/** Create a question with `count` answers, returning their real ids (answer
 * ids are real rows now that the link is a modifier_id column on answers). */
export const createAnswers = async (count: number): Promise<number[]> => {
  const q = await questionsTable.insert({ displayType: "radio", text: "Q?" });
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = await answersTable.insert({
      questionId: q.id,
      sortOrder: i,
      text: `A${i + 1}`,
    });
    ids.push(a.id);
  }
  return ids;
};

/** Create an answer-triggered modifier linked to `count` fresh answers. */
export const setUpAnswerModifier = async (
  count: number,
  input: Partial<ModifierInput> = {},
): Promise<{ answerIds: number[]; modifierId: number }> => {
  const answerIds = await createAnswers(count);
  const m = await insertModifier(input);
  await patchModifier(m.id, { trigger: "answer" });
  await setModifierAnswers(m.id, answerIds);
  return { answerIds, modifierId: m.id };
};

/** Resolve a one-item cart where each listed listing picked answers. */
export const resolveAnswerPicks = async (
  picks: Record<string, number[]>,
  quantities: Map<number, number>,
): Promise<ModifierSpec[]> =>
  resolveModifiers([checkoutItem()], {
    answerQuantities: await answerModifierQuantities(picks, quantities),
  });
