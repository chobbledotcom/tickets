import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllQuestionsWithAnswers,
  getQuestionWithAnswers,
} from "#shared/db/questions/queries.ts";
import { answersOrder, questionsOrder } from "#shared/db/questions/tables.ts";
import {
  addAnswer,
  createOrderedQuestionPair,
  createQuestion,
  createQuestionWithAnswers,
  expectQuestionTexts,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("custom questions > ordering", { db: true }, () => {
  describe("getNextAnswerSortOrder", () => {
    test("returns 0 for a question with no answers", async () => {
      const q = await createQuestion("Empty Q");
      expect(await answersOrder.next({ scope: q.id })).toBe(0);
    });

    test("returns max sort_order + 1 when answers exist", async () => {
      const q = await createQuestionWithAnswers("Q", ["A1", "A2"]);
      expect(await answersOrder.next({ scope: q.id })).toBe(2);
    });
  });
  describe("swapAnswerOrder", () => {
    test("swaps sort_order of two answers", async () => {
      const q = await createQuestion("Q");
      const a1 = await addAnswer(q.id, 0, "First");
      const a2 = await addAnswer(q.id, 1, "Second");
      await answersOrder.swap({
        first: a1.id,
        scope: q.id,
        second: a2.id,
      });
      const updated = await getQuestionWithAnswers(q.id);
      // After swap, "Second" should come first (sort_order 0) and "First" second (sort_order 1)
      expect(updated!.answers[0]!.text).toBe("Second");
      expect(updated!.answers[1]!.text).toBe("First");
    });
  });
  describe("question ordering", () => {
    test("assignNextQuestionSortOrder gives sequential non-zero orders", async () => {
      const q1 = await createQuestionWithAnswers("Q1", ["A"]);
      const q2 = await createQuestionWithAnswers("Q2", ["B"]);

      await questionsOrder.append({ key: q1.id });
      await questionsOrder.append({ key: q2.id });

      // Both are >= 1 (never 0, so they survive the legacy id-backfill) and q1
      // precedes q2 in the global list.
      const all = await getAllQuestionsWithAnswers();
      expectQuestionTexts(all, ["Q1", "Q2"]);
    });

    test("swapQuestionOrder reorders the global question list", async () => {
      const { q1, q2 } = await createOrderedQuestionPair("A", "B");

      await questionsOrder.swap({ first: q1.id, second: q2.id });

      const all = await getAllQuestionsWithAnswers();
      expectQuestionTexts(all, ["Q2", "Q1"]);
    });
  });
});
