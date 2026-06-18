import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { queryOne } from "#shared/db/client.ts";
import {
  answerAmountAllocations,
  answerModifierSpecs,
  answerPriceLabel,
  answerQuantitiesFromListingAnswers,
  answersTable,
  assignNextQuestionSortOrder,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionsWithAnswers,
  getAnswerCountsForQuestion,
  getAttendeeAnswersBatch,
  getListingQuestionIds,
  getNextAnswerSortOrder,
  getQuestionListingIds,
  getQuestionsForListing,
  getQuestionsWithListingIds,
  getQuestionWithAnswers,
  questionDisplayTypeError,
  questionsTable,
  requireQuestionDisplayType,
  saveAttendeeAnswers,
  setListingQuestions,
  setQuestionListings,
  swapAnswerOrder,
  swapQuestionOrder,
} from "#shared/db/questions.ts";
import { createTestListing, describeWithEnv } from "#test-utils";

/** Create a test attendee directly via the DB (bypasses routes) */
const createAttendee = async (listingId: number, name = "Alice") => {
  const result = await createAttendeeAtomic({
    bookings: [{ listingId }],
    email: `${name.toLowerCase()}@test.com`,
    name,
  });
  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }
  return result.attendees[0]!;
};

describeWithEnv("custom questions", { db: true }, () => {
  describe("questions CRUD", () => {
    test("rejects unsupported display types", () => {
      expect(() => requireQuestionDisplayType("dropdown")).toThrow(
        questionDisplayTypeError,
      );
    });

    test("creates and retrieves a question", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Favourite colour?",
      });
      expect(q.id).toBeGreaterThan(0);

      const found = await questionsTable.findById(q.id);
      expect(found).not.toBeNull();
      expect(found!.text).toBe("Favourite colour?");
    });

    test("updates a question", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Old text",
      });
      await questionsTable.update(q.id, { text: "New text" });
      const found = await questionsTable.findById(q.id);
      expect(found!.text).toBe("New text");
    });

    test("deletes a question and cascades", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "To delete",
      });
      const a = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Opt A",
      });

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [q.id]);

      const attendee = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[attendee.id, [a.id]]]));

      await deleteQuestion(q.id);

      expect(await questionsTable.findById(q.id)).toBeNull();
      expect(await getQuestionsForListing(listing.id)).toEqual([]);
      const answers = await getAttendeeAnswersBatch([attendee.id]);
      expect(answers.get(attendee.id)).toBeUndefined();
    });
  });

  describe("answers CRUD", () => {
    test("creates answers for a question", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });

      const withAnswers = await getQuestionWithAnswers(q.id);
      expect(withAnswers).not.toBeNull();
      expect(withAnswers!.answers).toHaveLength(2);
      expect(withAnswers!.answers[0]!.text).toBe("Small");
      expect(withAnswers!.answers[1]!.text).toBe("Large");
    });

    test("deletes a single answer", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const small = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });

      await deleteAnswer(small.id);

      const withAnswers = await getQuestionWithAnswers(q.id);
      expect(withAnswers!.answers).toHaveLength(1);
      expect(withAnswers!.answers[0]!.text).toBe("Large");
    });
  });

  describe("listing-question mapping", () => {
    test("assigns questions to an listing", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
      });

      const listing = await createTestListing();
      // Assign in reverse; the listing ignores assignment order and uses the
      // global question order (here creation/id order, since both are at the
      // default sort_order 0).
      await setListingQuestions(listing.id, [q2.id, q1.id]);

      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toHaveLength(2);
      expect(questions[0]!.text).toBe("Q1");
      expect(questions[1]!.text).toBe("Q2");
    });

    test("orders listing questions by the global sort_order, not assignment order", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      await assignNextQuestionSortOrder(q1.id);
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await assignNextQuestionSortOrder(q2.id);
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
      });

      // Put q2 ahead of q1 globally.
      await swapQuestionOrder(q1.id, q2.id);

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [q1.id, q2.id]);

      const questions = await getQuestionsForListing(listing.id);
      expect(questions.map((q) => q.text)).toEqual(["Q2", "Q1"]);
    });

    test("replaces listing questions on re-assignment", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
      });

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [q1.id, q2.id]);
      await setListingQuestions(listing.id, [q2.id]);

      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Q2");
    });

    test("includes assign-all questions for every listing", async () => {
      const q = await questionsTable.insert({
        assignAll: true,
        displayType: "radio",
        text: "Universal Q",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Yes",
      });

      const listing = await createTestListing();

      const questions = await getQuestionsForListing(listing.id);
      expect(questions.map((question) => question.text)).toEqual([
        "Universal Q",
      ]);
      expect(await getListingQuestionIds(listing.id)).toEqual([q.id]);
    });

    test("returns empty array for listing with no questions", async () => {
      const listing = await createTestListing();
      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toEqual([]);
    });

    test("skips questions with no answers", async () => {
      const qWithAnswers = await questionsTable.insert({
        displayType: "radio",
        text: "Has answers",
      });
      const qNoAnswers = await questionsTable.insert({
        displayType: "radio",
        text: "No answers",
      });
      await answersTable.insert({
        questionId: qWithAnswers.id,
        sortOrder: 0,
        text: "Yes",
      });

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [qWithAnswers.id, qNoAnswers.id]);

      const questions = await getQuestionsForListing(listing.id);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Has answers");
    });
  });

  describe("getListingQuestionIds", () => {
    test("returns assigned question IDs", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [q2.id, q1.id]);

      // Returned in the global question order, not the assignment order.
      const ids = await getListingQuestionIds(listing.id);
      expect(ids).toEqual([q1.id, q2.id]);
    });

    test("returns empty array for listing with no questions", async () => {
      const listing = await createTestListing();
      expect(await getListingQuestionIds(listing.id)).toEqual([]);
    });
  });

  describe("getQuestionListingIds", () => {
    test("returns the listings a question is assigned to", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await setListingQuestions(listing1.id, [q.id]);
      await setListingQuestions(listing2.id, [q.id]);

      const ids = await getQuestionListingIds(q.id);
      expect(ids.sort()).toEqual([listing1.id, listing2.id].sort());
    });

    test("returns empty array when assigned to no listings", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Lonely Q",
      });
      expect(await getQuestionListingIds(q.id)).toEqual([]);
    });
  });

  describe("setQuestionListings", () => {
    test("assigns a question to the selected listings", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });

      await setQuestionListings(q.id, [listing1.id, listing2.id]);

      expect((await getQuestionListingIds(q.id)).sort()).toEqual(
        [listing1.id, listing2.id].sort(),
      );
    });

    test("removes the question from unchecked listings", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await setQuestionListings(q.id, [listing1.id, listing2.id]);

      await setQuestionListings(q.id, [listing1.id]);

      expect(await getQuestionListingIds(q.id)).toEqual([listing1.id]);
    });

    test("lists a listing's assigned questions in the global question order", async () => {
      const existing = await questionsTable.insert({
        displayType: "radio",
        text: "Existing",
      });
      const added = await questionsTable.insert({
        displayType: "radio",
        text: "Added",
      });
      await answersTable.insert({
        questionId: existing.id,
        sortOrder: 0,
        text: "A",
      });
      await answersTable.insert({
        questionId: added.id,
        sortOrder: 0,
        text: "B",
      });

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [existing.id]);

      await setQuestionListings(added.id, [listing.id]);

      const ids = await getListingQuestionIds(listing.id);
      expect(ids).toEqual([existing.id, added.id]);
    });

    test("does nothing when the assignment is unchanged", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const listing = await createTestListing();
      await setQuestionListings(q.id, [listing.id]);

      await setQuestionListings(q.id, [listing.id]);

      expect(await getQuestionListingIds(q.id)).toEqual([listing.id]);
    });

    test("clears all listings when given an empty list", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const listing = await createTestListing();
      await setQuestionListings(q.id, [listing.id]);

      await setQuestionListings(q.id, []);

      expect(await getQuestionListingIds(q.id)).toEqual([]);
    });
  });

  describe("getQuestionsWithListingIds", () => {
    test("deduplicates questions across listings", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
      });

      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await setListingQuestions(listing1.id, [q1.id, q2.id]);
      await setListingQuestions(listing2.id, [q2.id]);

      const { questions } = await getQuestionsWithListingIds([
        listing1.id,
        listing2.id,
      ]);
      expect(questions).toHaveLength(2);
      expect(questions[0]!.text).toBe("Q1");
      expect(questions[1]!.text).toBe("Q2");
    });

    test("returns listing-ID mapping for each question", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "A2",
      });

      const listing1 = await createTestListing();
      const listing2 = await createTestListing({ name: "Listing 2" });
      await setListingQuestions(listing1.id, [q1.id, q2.id]);
      await setListingQuestions(listing2.id, [q2.id]);

      const { questionListingMap } = await getQuestionsWithListingIds([
        listing1.id,
        listing2.id,
      ]);
      expect(questionListingMap.get(q1.id)).toEqual([listing1.id]);
      const q2Listings = questionListingMap.get(q2.id)!;
      expect(q2Listings.sort()).toEqual([listing1.id, listing2.id].sort());
    });

    test("omits mapping for assign-all questions", async () => {
      const q = await questionsTable.insert({
        assignAll: true,
        displayType: "radio",
        text: "Universal Q",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Yes",
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
      const qWithAnswers = await questionsTable.insert({
        displayType: "radio",
        text: "Has answers",
      });
      const qNoAnswers = await questionsTable.insert({
        displayType: "radio",
        text: "No answers",
      });
      await answersTable.insert({
        questionId: qWithAnswers.id,
        sortOrder: 0,
        text: "Yes",
      });

      const listing = await createTestListing();
      await setListingQuestions(listing.id, [qWithAnswers.id, qNoAnswers.id]);

      const { questions } = await getQuestionsWithListingIds([listing.id]);
      expect(questions).toHaveLength(1);
      expect(questions[0]!.text).toBe("Has answers");
    });
  });

  describe("attendee answers", () => {
    test("saves and retrieves attendee answers", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });

      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);

      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const batch = await getAttendeeAnswersBatch([attendee.id]);
      expect(batch.get(attendee.id)).toEqual([a1.id]);
    });

    test("defaults amount applied when inserting an attendee answer", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const answer = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);

      await saveAttendeeAnswers(new Map([[attendee.id, [answer.id]]]));
      const stored = await queryOne<{ amount_applied: number }>(
        "SELECT amount_applied FROM attendee_answers WHERE attendee_id = ? AND answer_id = ?",
        [attendee.id, answer.id],
      );

      expect(stored?.amount_applied).toBe(0);
    });

    test("batch retrieval for multiple attendees", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });

      const listing = await createTestListing();
      const att1 = await createAttendee(listing.id, "Alice");
      const att2 = await createAttendee(listing.id, "Bob");

      await saveAttendeeAnswers(new Map([[att1.id, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[att2.id, [a2.id]]]));

      const batch = await getAttendeeAnswersBatch([att1.id, att2.id]);
      expect(batch.get(att1.id)).toEqual([a1.id]);
      expect(batch.get(att2.id)).toEqual([a2.id]);
    });

    test("empty batch for no attendees", async () => {
      const batch = await getAttendeeAnswersBatch([]);
      expect(batch.size).toBe(0);
    });

    test("saveAttendeeAnswers does nothing for an empty map", async () => {
      await saveAttendeeAnswers(new Map());
      // No error thrown, no batch executed
    });

    test("saveAttendeeAnswers skips inserts for an answerless attendee", async () => {
      await saveAttendeeAnswers(new Map([[1, []]]));
      // No error thrown, no rows inserted (delete-only path)
    });

    test("saveAttendeeAnswers replaces existing answers atomically", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Colour?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Blue",
      });

      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[att.id, [a1.id]]]));

      const before = await getAttendeeAnswersBatch([att.id]);
      expect(before.get(att.id)).toEqual([a1.id]);

      await saveAttendeeAnswers(new Map([[att.id, [a2.id]]]));

      const after = await getAttendeeAnswersBatch([att.id]);
      expect(after.get(att.id)).toEqual([a2.id]);
    });

    test("saveAttendeeAnswers with empty answerIds clears answers", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Colour?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });

      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[att.id, [a1.id]]]));

      await saveAttendeeAnswers(new Map([[att.id, []]]));

      const after = await getAttendeeAnswersBatch([att.id]);
      expect(after.get(att.id)).toBeUndefined();
    });
  });

  describe("getAllQuestionsWithAnswers", () => {
    test("returns all questions with their answers", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A1",
      });
      await answersTable.insert({
        questionId: q1.id,
        sortOrder: 1,
        text: "A2",
      });
      await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "B1",
      });

      const all = await getAllQuestionsWithAnswers();
      expect(all).toHaveLength(2);

      const qWithA1 = all.find((q) => q.text === "Q1")!;
      expect(qWithA1.answers).toHaveLength(2);

      const qWithA2 = all.find((q) => q.text === "Q2")!;
      expect(qWithA2.answers).toHaveLength(1);
    });
  });

  describe("getNextAnswerSortOrder", () => {
    test("returns 0 for a question with no answers", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Empty Q",
      });
      expect(await getNextAnswerSortOrder(q.id)).toBe(0);
    });

    test("returns max sort_order + 1 when answers exist", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      await answersTable.insert({ questionId: q.id, sortOrder: 0, text: "A1" });
      await answersTable.insert({ questionId: q.id, sortOrder: 1, text: "A2" });
      expect(await getNextAnswerSortOrder(q.id)).toBe(2);
    });
  });

  describe("getAnswerCountsForQuestion", () => {
    test("returns zero counts when no attendees have answered", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Color?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Blue",
      });
      const counts = await getAnswerCountsForQuestion(q.id);
      expect(counts.get(a1.id)).toBe(0);
      expect(counts.get(a2.id)).toBe(0);
    });

    test("counts attendee answers correctly", async () => {
      const listing = await createTestListing();
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "S",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "M",
      });
      const att1 = await createAttendee(listing.id, "Alice");
      const att2 = await createAttendee(listing.id, "Bob");
      await saveAttendeeAnswers(new Map([[att1.id, [a1.id]]]));
      await saveAttendeeAnswers(new Map([[att2.id, [a1.id]]]));
      const counts = await getAnswerCountsForQuestion(q.id);
      expect(counts.get(a1.id)).toBe(2);
      expect(counts.get(a2.id)).toBe(0);
    });
  });

  describe("swapAnswerOrder", () => {
    test("swaps sort_order of two answers", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "First",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Second",
      });
      await swapAnswerOrder(a1.id, 0, a2.id, 1);
      const updated = await getQuestionWithAnswers(q.id);
      // After swap, "Second" should come first (sort_order 0) and "First" second (sort_order 1)
      expect(updated!.answers[0]!.text).toBe("Second");
      expect(updated!.answers[1]!.text).toBe("First");
    });
  });

  describe("answer price modifiers", () => {
    test("stores answer modifier fields and resolves them as checkout specs", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Meal?",
      });
      const answer = await answersTable.insert({
        calcKind: "fixed",
        calcValue: 2.5,
        direction: "charge",
        questionId: q.id,
        sortOrder: 0,
        text: "Premium meal",
      });
      const discount = await answersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        questionId: q.id,
        sortOrder: 1,
        text: "Member discount",
      });
      const multiplier = await answersTable.insert({
        calcKind: "multiply",
        calcValue: 1.5,
        direction: "charge",
        questionId: q.id,
        sortOrder: 2,
        text: "VIP multiplier",
      });

      const specs = await answerModifierSpecs([
        answer.id,
        discount.id,
        multiplier.id,
      ]);

      expect(answerPriceLabel(answer)).toBe("+£2.50");
      expect(answerPriceLabel(discount)).toBe("−10%");
      expect(answerPriceLabel(multiplier)).toBe("×1.5");
      expect(specs).toEqual([
        {
          id: answer.id,
          kind: "fixed",
          listingIds: null,
          name: "Premium meal",
          quantity: 1,
          source: "answer",
          trigger: "automatic",
          value: 250,
        },
        {
          id: discount.id,
          kind: "percent",
          listingIds: null,
          name: "Member discount",
          quantity: 1,
          source: "answer",
          trigger: "automatic",
          value: -10,
        },
        {
          id: multiplier.id,
          kind: "multiply",
          listingIds: null,
          name: "VIP multiplier",
          quantity: 1,
          source: "answer",
          trigger: "automatic",
          value: 1.5,
        },
      ]);
    });

    test("counts answer modifier quantities from selected listing quantities", () => {
      const quantities = answerQuantitiesFromListingAnswers(
        { "1": [10, 11], "2": [10], "3": [12] },
        new Map([
          [1, 2],
          [2, 3],
        ]),
      );

      expect(quantities).toEqual(
        new Map([
          [10, 5],
          [11, 2],
          [12, 0],
        ]),
      );
    });

    test("allocates answer modifier revenue across attendee answer rows", () => {
      expect(
        answerAmountAllocations([
          {
            amountApplied: 250,
            delta: 250,
            modifierId: 9,
            quantity: 1,
            scopedSubtotal: 1000,
            source: "modifier",
          },
          {
            amountApplied: 500,
            delta: 500,
            modifierId: 10,
            quantity: 3,
            scopedSubtotal: 1000,
            source: "answer",
          },
        ]),
      ).toEqual(new Map([[10, [167, 167, 166]]]));
    });

    test("answer aggregate triggers track uses and revenue", async () => {
      const listing = await createTestListing();
      const attendees = await Promise.all([
        createAttendee(listing.id, "Alice"),
        createAttendee(listing.id, "Bob"),
        createAttendee(listing.id, "Cara"),
      ]);
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Meal?",
      });
      const answer = await answersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        questionId: q.id,
        sortOrder: 0,
        text: "Premium meal",
      });

      await saveAttendeeAnswers(
        new Map(attendees.map((attendee) => [attendee.id, [answer.id]])),
        new Map([[answer.id, [167, 167, 166]]]),
      );

      const updated = (await answersTable.findById(answer.id))!;
      expect(updated.total_uses).toBe(3);
      expect(updated.usage_count).toBe(3);
      expect(updated.total_revenue).toBe(500);
    });

    test("ignores answers without a complete price modifier", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Meal?",
      });
      const answer = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Standard meal",
      });

      expect(answerPriceLabel(answer)).toBe("");
      expect(await answerModifierSpecs([answer.id])).toEqual([]);
    });
  });

  describe("question ordering", () => {
    test("assignNextQuestionSortOrder gives sequential non-zero orders", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await answersTable.insert({ questionId: q1.id, sortOrder: 0, text: "A" });
      await answersTable.insert({ questionId: q2.id, sortOrder: 0, text: "B" });

      await assignNextQuestionSortOrder(q1.id);
      await assignNextQuestionSortOrder(q2.id);

      // Both are >= 1 (never 0, so they survive the legacy id-backfill) and q1
      // precedes q2 in the global list.
      const all = await getAllQuestionsWithAnswers();
      expect(all.map((q) => q.text)).toEqual(["Q1", "Q2"]);
    });

    test("swapQuestionOrder reorders the global question list", async () => {
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Q1",
      });
      await assignNextQuestionSortOrder(q1.id);
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Q2",
      });
      await assignNextQuestionSortOrder(q2.id);
      await answersTable.insert({ questionId: q1.id, sortOrder: 0, text: "A" });
      await answersTable.insert({ questionId: q2.id, sortOrder: 0, text: "B" });

      await swapQuestionOrder(q1.id, q2.id);

      const all = await getAllQuestionsWithAnswers();
      expect(all.map((q) => q.text)).toEqual(["Q2", "Q1"]);
    });
  });
});
