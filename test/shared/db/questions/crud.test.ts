import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { queryAll } from "#shared/db/client.ts";
import {
  questionDisplayTypeError,
  requireQuestionDisplayType,
} from "#shared/db/question-types.ts";
import {
  getAttendeeAnswersBatch,
  saveAttendeeAnswers,
} from "#shared/db/questions/attendee-answers.ts";
import { deleteAnswer, deleteQuestion } from "#shared/db/questions/delete.ts";
import {
  getAllQuestionsWithAnswers,
  getQuestionsForListing,
  getQuestionWithAnswers,
  setListingQuestions,
} from "#shared/db/questions/queries.ts";
import {
  assignNextQuestionSortOrder,
  getNextAnswerSortOrder,
  swapAnswerOrder,
  swapQuestionOrder,
} from "#shared/db/questions/sort-order.ts";
import {
  getOrCreateStringIds,
  pairStringIds,
} from "#shared/db/questions/strings.ts";
import { questionsTable } from "#shared/db/questions/tables.ts";
import { createTestListing, describeWithEnv } from "#test-utils";
import {
  addAnswer,
  createAttendee,
  createOrderedQuestionPair,
  createQuestion,
  createQuestionWithAnswers,
  expectQuestionTexts,
} from "./helpers.ts";

describeWithEnv("custom questions", { db: true }, () => {
  describe("questions CRUD", () => {
    test("rejects unsupported display types", () => {
      expect(() => requireQuestionDisplayType("dropdown")).toThrow(
        questionDisplayTypeError,
      );
    });

    test("creates and retrieves a question", async () => {
      const q = await createQuestion("Favourite colour?");
      expect(q.id).toBeGreaterThan(0);

      const found = await questionsTable.findById(q.id);
      expect(found).not.toBeNull();
      expect(found!.text).toBe("Favourite colour?");
    });

    test("updates a question", async () => {
      const q = await createQuestion("Old text");
      await questionsTable.update(q.id, { text: "New text" });
      const found = await questionsTable.findById(q.id);
      expect(found!.text).toBe("New text");
    });

    test("deletes a question and cascades", async () => {
      const q = await createQuestion("To delete");
      const a = await addAnswer(q.id, 0, "Opt A");

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
      const q = await createQuestionWithAnswers("Size?", ["Small", "Large"]);

      const withAnswers = await getQuestionWithAnswers(q.id);
      expect(withAnswers).not.toBeNull();
      expect(withAnswers!.answers).toHaveLength(2);
      expect(withAnswers!.answers[0]!.text).toBe("Small");
      expect(withAnswers!.answers[1]!.text).toBe("Large");
    });

    test("deletes a single answer", async () => {
      const q = await createQuestion("Size?");
      const small = await addAnswer(q.id, 0, "Small");
      await addAnswer(q.id, 1, "Large");

      await deleteAnswer(small.id);

      const withAnswers = await getQuestionWithAnswers(q.id);
      expect(withAnswers!.answers).toHaveLength(1);
      expect(withAnswers!.answers[0]!.text).toBe("Large");
    });
  });
  describe("getOrCreateStringIds", () => {
    test("returns a complete map of real ids for brand-new texts", async () => {
      const texts = ["Wheelchair access", "Vegan meal", "Front row"];
      const ids = await getOrCreateStringIds(texts);

      // Every input text resolves to a distinct, positive-integer id with no
      // undefined slipping through. An undefined here is exactly what dropped
      // the `s` from a checkout's signed metadata and later made the webhook
      // bind an unsupported value, so this is the core read-your-writes guard.
      expect([...ids.keys()].sort()).toEqual([...texts].sort());
      // Distinct texts must resolve to distinct ids — no collision or reuse.
      expect(new Set(ids.values()).size).toBe(texts.length);

      // Each id must point at the row for that exact text, proven via the blind
      // index — this also proves every id is a real row id (not undefined or a
      // wrong number): a mutant id matches no row or a different text_index.
      for (const text of texts) {
        const rows = await queryAll<{ text_index: string }>(
          "SELECT text_index FROM strings WHERE id = ?",
          [ids.get(text)!],
        );
        expect(rows.length).toBe(1);
        expect(rows[0]!.text_index).toBe(await hmacHash(text));
      }
    });

    test("dedupes repeated input text to one id", async () => {
      const ids = await getOrCreateStringIds(["Same", "Same", "Same"]);
      expect([...ids.keys()]).toEqual(["Same"]);
      expect(Number.isInteger(ids.get("Same"))).toBe(true);
    });

    test("returns an empty map for no texts", async () => {
      const ids = await getOrCreateStringIds([]);
      expect(ids.size).toBe(0);
    });
  });
  describe("pairStringIds", () => {
    test("pairs each text with the id matching its text_index", () => {
      const rows = [
        { text: "alpha", textIndex: "idx-a" },
        { text: "beta", textIndex: "idx-b" },
      ];
      // Deliberately out of order to prove pairing is by index, not position.
      const found = [
        { id: 11, text_index: "idx-b" },
        { id: 7, text_index: "idx-a" },
      ];
      expect(pairStringIds(rows, found)).toEqual(
        new Map([
          ["alpha", 7],
          ["beta", 11],
        ]),
      );
    });

    test("throws naming the text_index when a written row is missing", () => {
      const rows = [{ text: "ghost", textIndex: "idx-missing" }];
      // A missing row is the read-your-writes failure that must fail loudly
      // rather than yield an undefined id callers would bind into SQL.
      expect(() => pairStringIds(rows, [])).toThrow("idx-missing");
    });

    test("returns an empty map for no rows", () => {
      expect(pairStringIds([], []).size).toBe(0);
    });
  });
  describe("getNextAnswerSortOrder", () => {
    test("returns 0 for a question with no answers", async () => {
      const q = await createQuestion("Empty Q");
      expect(await getNextAnswerSortOrder(q.id)).toBe(0);
    });

    test("returns max sort_order + 1 when answers exist", async () => {
      const q = await createQuestionWithAnswers("Q", ["A1", "A2"]);
      expect(await getNextAnswerSortOrder(q.id)).toBe(2);
    });
  });
  describe("swapAnswerOrder", () => {
    test("swaps sort_order of two answers", async () => {
      const q = await createQuestion("Q");
      const a1 = await addAnswer(q.id, 0, "First");
      const a2 = await addAnswer(q.id, 1, "Second");
      await swapAnswerOrder(a1.id, 0, a2.id, 1);
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

      await assignNextQuestionSortOrder(q1.id);
      await assignNextQuestionSortOrder(q2.id);

      // Both are >= 1 (never 0, so they survive the legacy id-backfill) and q1
      // precedes q2 in the global list.
      const all = await getAllQuestionsWithAnswers();
      expectQuestionTexts(all, ["Q1", "Q2"]);
    });

    test("swapQuestionOrder reorders the global question list", async () => {
      const { q1, q2 } = await createOrderedQuestionPair("A", "B");

      await swapQuestionOrder(q1.id, q2.id);

      const all = await getAllQuestionsWithAnswers();
      expectQuestionTexts(all, ["Q2", "Q1"]);
    });
  });
});
