import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import {
  answersTable,
  assignNextQuestionSortOrder,
  deleteAnswer,
  deleteQuestion,
  getAllQuestionListingIds,
  getAllQuestionsWithAnswers,
  getAnswerAggregateRecalculation,
  getAnswerSelectionTotals,
  getAttendeeAnswersBatch,
  getAttendeeTextAnswers,
  getListingQuestionIds,
  getNextAnswerSortOrder,
  getOrCreateStringIds,
  getQuestionListingIds,
  getQuestionsForListing,
  getQuestionsWithListingIds,
  getQuestionWithAnswers,
  questionDisplayTypeError,
  questionsTable,
  requireQuestionDisplayType,
  resetAnswerAggregateFields,
  saveAttendeeAnswers,
  setListingQuestions,
  setQuestionListings,
  swapAnswerOrder,
  swapQuestionOrder,
  updateAnswerAggregateValues,
} from "#shared/db/questions.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

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
      const answers = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
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

      const batch = await getAttendeeAnswersBatch([attendee.id], {
        texts: false,
      });
      expect(batch.get(attendee.id)).toEqual([a1.id]);
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

      const batch = await getAttendeeAnswersBatch([att1.id, att2.id], {
        texts: false,
      });
      expect(batch.get(att1.id)).toEqual([a1.id]);
      expect(batch.get(att2.id)).toEqual([a2.id]);
    });

    test("empty batch for no attendees", async () => {
      const batch = await getAttendeeAnswersBatch([], { texts: false });
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

    test("saveAttendeeAnswers skips answer ids whose answer was deleted", async () => {
      // An answer (and its question) can be removed between checkout and
      // finalize. A dangling answer id is dropped rather than throwing, so an
      // already-captured payment's finalize still completes instead of failing
      // repeatedly.
      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[att.id, [999_999]]]));
      const after = await getAttendeeAnswersBatch([att.id], { texts: false });
      expect(after.get(att.id)).toBeUndefined();
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

      const before = await getAttendeeAnswersBatch([att.id], { texts: false });
      expect(before.get(att.id)).toEqual([a1.id]);

      await saveAttendeeAnswers(new Map([[att.id, [a2.id]]]));

      const after = await getAttendeeAnswersBatch([att.id], { texts: false });
      expect(after.get(att.id)).toEqual([a2.id]);
    });

    test("saves text-only answers and decrypts them for editing", async () => {
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Accessibility needs?",
      });
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);

      await saveAttendeeAnswers(
        new Map([
          [
            attendee.id,
            {
              answerIds: [],
              textAnswers: [{ questionId: q.id, text: "Front row please" }],
            },
          ],
        ]),
      );

      const textAnswers = await getAttendeeTextAnswers(
        attendee.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q.id)).toBe("Front row please");

      const strings = await queryAll<{ created: string; used_count: number }>(
        "SELECT created, used_count FROM strings",
      );
      expect(strings.map((row) => row.used_count)).toEqual([1]);
      expect(Number.isNaN(Date.parse(strings[0]!.created))).toBe(false);
    });

    test("deduplicates repeated text answers by question before saving", async () => {
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Accessibility needs?",
      });
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);

      await saveAttendeeAnswers(
        new Map([
          [
            attendee.id,
            {
              answerIds: [],
              textAnswers: [
                { questionId: q.id, text: "First answer" },
                { questionId: q.id, text: "Final answer" },
              ],
            },
          ],
        ]),
      );

      const textAnswers = await getAttendeeTextAnswers(
        attendee.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q.id)).toBe("Final answer");

      const strings = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(strings.map((row) => row.used_count)).toEqual([1]);
    });

    test("re-saving an unchanged sole-user text answer keeps it readable", async () => {
      // Regression: strings used to be resolved before the per-attendee delete,
      // so a sole user re-saving the same text had its string dropped by the
      // delete trigger and the re-insert pointed at a now-missing row.
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Notes?",
      });
      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      const answerSet = {
        answerIds: [],
        textAnswers: [{ questionId: q.id, text: "Keep me" }],
      };

      await saveAttendeeAnswers(new Map([[att.id, answerSet]]));
      await saveAttendeeAnswers(new Map([[att.id, answerSet]]));

      const textAnswers = await getAttendeeTextAnswers(
        att.id,
        await getTestPrivateKey(),
      );
      expect(textAnswers.get(q.id)).toBe("Keep me");
    });

    test("deduplicates identical text answers and prunes them when unused", async () => {
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Dietary needs?",
      });
      const listing = await createTestListing();
      const att1 = await createAttendee(listing.id, "Alice");
      const att2 = await createAttendee(listing.id, "Bob");
      const answerSet = {
        answerIds: [],
        textAnswers: [{ questionId: q.id, text: "Vegan" }],
      };

      await saveAttendeeAnswers(
        new Map([
          [att1.id, answerSet],
          [att2.id, answerSet],
        ]),
      );

      const afterInsert = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(afterInsert.map((row) => row.used_count)).toEqual([2]);

      await saveAttendeeAnswers(new Map([[att1.id, []]]));
      const afterOneClear = await queryAll<{ used_count: number }>(
        "SELECT used_count FROM strings",
      );
      expect(afterOneClear.map((row) => row.used_count)).toEqual([1]);

      await saveAttendeeAnswers(new Map([[att2.id, []]]));
      const afterAllClear = await queryAll<{ id: number }>(
        "SELECT id FROM strings",
      );
      expect(afterAllClear).toEqual([]);
    });

    test("skips a text answer whose question was deleted at finalize", async () => {
      // A free-text question can be deleted between checkout and finalize; the
      // signed metadata still references it, but inserting would create an
      // orphan row whose plaintext the admin UI can never surface, so it is
      // dropped.
      const listing = await createTestListing();
      const att = await createAttendee(listing.id);
      await saveAttendeeAnswers(
        new Map([
          [
            att.id,
            {
              answerIds: [],
              textAnswers: [{ questionId: 999_999, text: "orphan" }],
            },
          ],
        ]),
      );
      const texts = await getAttendeeTextAnswers(
        att.id,
        await getTestPrivateKey(),
      );
      expect(texts.size).toBe(0);
    });

    test("refreshes created on a reused but still-unattached string", async () => {
      const ids = await getOrCreateStringIds(["reuse me"]);
      const id = ids.get("reuse me")!;
      // Backdate it as if abandoned by an earlier checkout.
      await execute({
        args: ["2000-01-01T00:00:00Z", id],
        sql: "UPDATE strings SET created = ? WHERE id = ?",
      });

      const reused = await getOrCreateStringIds(["reuse me"]);
      expect(reused.get("reuse me")).toBe(id);

      const rows = await queryAll<{ created: string }>(
        "SELECT created FROM strings WHERE id = ?",
        [id],
      );
      expect(rows[0]!.created > "2001-01-01").toBe(true);
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

      const after = await getAttendeeAnswersBatch([att.id], { texts: false });
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

  describe("getAllQuestionListingIds", () => {
    test("maps each question to its assigned listing ids", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Q",
      });
      const l1 = await createTestListing({ name: "Alpha" });
      const l2 = await createTestListing({ name: "Beta" });
      await setQuestionListings(q.id, [l1.id, l2.id]);

      const map = await getAllQuestionListingIds();
      expect(map.get(q.id)!.sort()).toEqual([l1.id, l2.id].sort());
    });

    test("omits questions assigned to no listings", async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Lonely",
      });
      const map = await getAllQuestionListingIds();
      expect(map.has(q.id)).toBe(false);
    });
  });

  describe("answer selection aggregate", () => {
    const seedAnswer = async () => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const a = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      return { a, q };
    };

    test("getAnswerSelectionTotals returns the stored times_selected", async () => {
      const { a, q } = await seedAnswer();
      await updateAnswerAggregateValues(a.id, { times_selected: 9 });
      const totals = await getAnswerSelectionTotals(q.id);
      expect(totals.get(a.id)).toBe(9);
    });

    test("the attendee_answers trigger maintains times_selected", async () => {
      const { a, q } = await seedAnswer();
      const listing = await createTestListing();
      const att = await createAttendee(listing.id);

      await saveAttendeeAnswers(new Map([[att.id, [a.id]]]));
      expect((await getAnswerSelectionTotals(q.id)).get(a.id)).toBe(1);

      await saveAttendeeAnswers(new Map([[att.id, []]]));
      expect((await getAnswerSelectionTotals(q.id)).get(a.id)).toBe(0);
    });

    test("getAnswerAggregateRecalculation flags drift from attendee answers", async () => {
      const { a } = await seedAnswer();
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[attendee.id, [a.id]]]));
      // Force the stored total out of step with the one real selection.
      await updateAnswerAggregateValues(a.id, { times_selected: 42 });

      const recalc = await getAnswerAggregateRecalculation(a.id);
      expect(recalc.times_selected.current).toBe(42);
      expect(recalc.times_selected.recalculated).toBe(1);
    });

    test("resetAnswerAggregateFields rebuilds the stored total", async () => {
      const { a } = await seedAnswer();
      const listing = await createTestListing();
      const attendee = await createAttendee(listing.id);
      await saveAttendeeAnswers(new Map([[attendee.id, [a.id]]]));
      await updateAnswerAggregateValues(a.id, { times_selected: 42 });

      await resetAnswerAggregateFields(a.id, ["times_selected"]);

      const recalc = await getAnswerAggregateRecalculation(a.id);
      expect(recalc.times_selected.current).toBe(1);
      expect(recalc.times_selected.recalculated).toBe(1);
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
