import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllQuestionsWithAnswers,
  getAnswerAggregateRecalculation,
  getAnswerSelectionTotals,
  getQuestionsWithListingIds,
  resetAnswerAggregateFields,
  saveAttendeeAnswers,
  setListingQuestions,
  updateAnswerAggregateValues,
} from "#shared/db/questions.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import {
  addAnswer,
  createAttendee,
  createQuestion,
  createQuestionWithAnswers,
  expectQuestionTexts,
  seedQuestionWithAndWithoutAnswers,
} from "./helpers.ts";

describeWithEnv("custom questions", { db: true }, () => {
  describe("getQuestionsWithListingIds", () => {
    /** Two questions, each with one answer: Q1 assigned to both listings, Q2
     *  assigned to listing2 only. Shared setup for the dedup and listing-map
     *  tests below, which just read the result two different ways. */
    const seedTwoQuestionsAcrossListings = async () => {
      const q1 = await createQuestionWithAnswers("Q1", ["A1"]);
      const q2 = await createQuestionWithAnswers("Q2", ["A2"]);
      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await setListingQuestions(listing1.id, [q1.id, q2.id]);
      await setListingQuestions(listing2.id, [q2.id]);
      return { listing1, listing2, q1, q2 };
    };

    test("deduplicates questions across listings", async () => {
      const { listing1, listing2 } = await seedTwoQuestionsAcrossListings();

      const { questions } = await getQuestionsWithListingIds([
        listing1.id,
        listing2.id,
      ]);
      expectQuestionTexts(questions, ["Q1", "Q2"]);
    });

    test("returns listing-ID mapping for each question", async () => {
      const { listing1, listing2, q1, q2 } =
        await seedTwoQuestionsAcrossListings();

      const { questionListingMap } = await getQuestionsWithListingIds([
        listing1.id,
        listing2.id,
      ]);
      expect(questionListingMap.get(q1.id)).toEqual([listing1.id]);
      const q2Listings = questionListingMap.get(q2.id)!;
      expect(q2Listings.sort()).toEqual([listing1.id, listing2.id].sort());
    });

    test("omits mapping for assign-all questions", async () => {
      const q = await createQuestionWithAnswers("Universal Q", ["Yes"], {
        assignAll: true,
      });
      const listing = await createTestListing();

      const { questionListingMap, questions } =
        await getQuestionsWithListingIds([listing.id]);

      expect(questions.map((question) => question.text)).toEqual([
        "Universal Q",
      ]);
      expect(questionListingMap.has(q.id)).toBe(false);
    });

    test("returns empty for no listings", async () => {
      const { questions, questionListingMap } =
        await getQuestionsWithListingIds([]);
      expect(questions).toEqual([]);
      expect(questionListingMap.size).toBe(0);
    });

    test("skips questions with no answers", async () => {
      const { listing } = await seedQuestionWithAndWithoutAnswers();

      const { questions } = await getQuestionsWithListingIds([listing.id]);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Has answers");
    });
  });
  describe("getAllQuestionsWithAnswers", () => {
    test("returns all questions with their answers", async () => {
      const q1 = await createQuestionWithAnswers("Q1", ["A1", "A2"]);
      const q2 = await createQuestionWithAnswers("Q2", ["B1"]);

      const all = await getAllQuestionsWithAnswers();
      expect(all).toHaveLength(2);

      const qWithA1 = all.find((q) => q.text === q1.text)!;
      expect(qWithA1.answers).toHaveLength(2);

      const qWithA2 = all.find((q) => q.text === q2.text)!;
      expect(qWithA2.answers).toHaveLength(1);
    });
  });
  describe("answer selection aggregate", () => {
    const seedAnswer = async () => {
      const q = await createQuestion("Size?");
      const a = await addAnswer(q.id, 0, "Small");
      return { a, q };
    };

    /** A seeded answer, a real attendee, and one selection already saved —
     *  the shared starting point for every aggregate-drift test below. */
    const seedSelectedAnswer = async () => {
      const { a, q } = await seedAnswer();
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[attendee.id, [a.id]]]));
      return { a, attendee, q };
    };

    test("getAnswerSelectionTotals returns the stored times_selected", async () => {
      const { a, q } = await seedAnswer();
      await updateAnswerAggregateValues(a.id, { times_selected: 9 });
      const totals = await getAnswerSelectionTotals(q.id);
      expect(totals.get(a.id)).toBe(9);
    });

    test("the attendee_answers trigger maintains times_selected", async () => {
      const { a, attendee, q } = await seedSelectedAnswer();
      expect((await getAnswerSelectionTotals(q.id)).get(a.id)).toBe(1);

      await saveAttendeeAnswers(new Map([[attendee.id, []]]));
      expect((await getAnswerSelectionTotals(q.id)).get(a.id)).toBe(0);
    });

    test("getAnswerAggregateRecalculation flags drift from attendee answers", async () => {
      const { a } = await seedSelectedAnswer();
      // Force the stored total out of step with the one real selection.
      await updateAnswerAggregateValues(a.id, { times_selected: 42 });

      const recalc = await getAnswerAggregateRecalculation(a.id);
      expect(recalc.times_selected.current).toBe(42);
      expect(recalc.times_selected.recalculated).toBe(1);
    });

    test("resetAnswerAggregateFields rebuilds the stored total", async () => {
      const { a } = await seedSelectedAnswer();
      await updateAnswerAggregateValues(a.id, { times_selected: 42 });

      await resetAnswerAggregateFields(a.id, ["times_selected"]);

      const recalc = await getAnswerAggregateRecalculation(a.id);
      expect(recalc.times_selected.current).toBe(1);
      expect(recalc.times_selected.recalculated).toBe(1);
    });
  });
});
