import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryOne } from "#db/client.ts";
import {
  answerAggregates,
  getAnswerAggregateRecalculation,
  getAnswerModifierId,
  getAnswerSelectionTotals,
  setAnswerModifier,
} from "#db/questions/aggregates.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** A question with two answers, the first picked once, then that answer's
 * stored total pushed off the truth so every check starts from real drift. */
const questionWithADriftedTotal = async () => {
  const listing = await createTestListing();
  const question = await createQuestion("Size?");
  const small = await addAnswer(question.id, 0, "S");
  const large = await addAnswer(question.id, 1, "L");
  const attendee = await createAttendee(listing.id);
  await saveAttendeeAnswers(
    new Map([[attendee.id, { answerIds: [small.id], textAnswers: [] }]]),
  );
  await answerAggregates.update(small.id, { times_selected: 42 });
  return { large, question, small };
};

const storedTotal = async (answerId: number): Promise<number | undefined> =>
  (
    await queryOne<{ times_selected: number }>(
      "SELECT times_selected FROM answers WHERE id = ?",
      [answerId],
    )
  )?.times_selected;

describeWithEnv("db > answer aggregates", { db: true }, () => {
  describe("getAnswerSelectionTotals", () => {
    test("keys every answer of the question by its stored total", async () => {
      const { question, small, large } = await questionWithADriftedTotal();
      expect(await getAnswerSelectionTotals(question.id)).toEqual(
        new Map([
          [small.id, 42],
          [large.id, 0],
        ]),
      );
    });

    test("is empty for a question with no answers", async () => {
      const question = await createQuestion("Nothing?");
      expect(await getAnswerSelectionTotals(question.id)).toEqual(new Map());
    });
  });

  describe("getAnswerAggregateRecalculation", () => {
    test("pairs the stored total with the one counted from attendees", async () => {
      const { small } = await questionWithADriftedTotal();
      expect(await getAnswerAggregateRecalculation(small.id)).toEqual({
        times_selected: { current: 42, recalculated: 1 },
      });
    });

    test("counts zero for an answer nobody picked", async () => {
      const { large } = await questionWithADriftedTotal();
      expect(await getAnswerAggregateRecalculation(large.id)).toEqual({
        times_selected: { current: 0, recalculated: 0 },
      });
    });
  });

  describe("answerAggregates", () => {
    test("update writes the total, and only for the named answer", async () => {
      const { small, large } = await questionWithADriftedTotal();
      await answerAggregates.update(large.id, { times_selected: 7 });
      expect(await storedTotal(large.id)).toBe(7);
      expect(await storedTotal(small.id)).toBe(42);
    });

    test("reset rebuilds the total from the attendee answers", async () => {
      const { small } = await questionWithADriftedTotal();
      await answerAggregates.reset(small.id, ["times_selected"]);
      expect(await storedTotal(small.id)).toBe(1);
    });

    test("reset changes nothing when no column is named", async () => {
      const { small } = await questionWithADriftedTotal();
      await answerAggregates.reset(small.id, []);
      expect(await storedTotal(small.id)).toBe(42);
    });
  });

  describe("the modifier an answer triggers", () => {
    test("is null until one is set", async () => {
      const { small } = await questionWithADriftedTotal();
      expect(await getAnswerModifierId(small.id)).toBeNull();
    });

    test("is read back after it is set, and cleared by null", async () => {
      const { small } = await questionWithADriftedTotal();
      await setAnswerModifier(small.id, 3);
      expect(await getAnswerModifierId(small.id)).toBe(3);
      await setAnswerModifier(small.id, null);
      expect(await getAnswerModifierId(small.id)).toBeNull();
    });

    test("is set for the named answer alone", async () => {
      const { small, large } = await questionWithADriftedTotal();
      await setAnswerModifier(small.id, 3);
      expect(await getAnswerModifierId(large.id)).toBeNull();
    });
  });
});
