import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  questionDisplayTypeError,
  requireQuestionDisplayType,
} from "#shared/db/question-types.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { deleteAnswer, deleteQuestion } from "#shared/db/questions/delete.ts";
import {
  getQuestionsForListing,
  getQuestionWithAnswers,
  listingQuestions,
} from "#shared/db/questions/queries.ts";
import { questionsTable } from "#shared/db/questions/tables.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
  createQuestionWithAnswers,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describeWithEnv(
  "custom questions > questions and answers",
  { db: true },
  () => {
    describe("questions CRUD", () => {
      test("rejects unsupported display types", () => {
        expect(() => requireQuestionDisplayType("dropdown")).toThrow(
          questionDisplayTypeError,
        );
      });

      test("creates and retrieves a question", async () => {
        const q = await createQuestion("Favourite colour?");
        expect(q.id).toBeGreaterThan(0);

        const found = await questionsTable.read.one({ id: q.id });
        expect(found).not.toBeNull();
        expect(found!.text).toBe("Favourite colour?");
      });

      test("updates a question", async () => {
        const q = await createQuestion("Old text");
        await questionsTable.update(q.id, { text: "New text" });
        const found = await questionsTable.read.one({ id: q.id });
        expect(found!.text).toBe("New text");
      });

      test("deletes a question and cascades", async () => {
        const q = await createQuestion("To delete");
        const a = await addAnswer(q.id, 0, "Opt A");

        const listing = await createTestListing();
        await listingQuestions.setIds(listing.id, [q.id]);

        const attendee = await createAttendee(listing.id);
        await saveAttendeeAnswers(new Map([[attendee.id, [a.id]]]));

        await deleteQuestion(q.id);

        expect(await questionsTable.read.one({ id: q.id })).toBeNull();
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
  },
);
