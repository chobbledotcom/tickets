import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { deleteAnswer, deleteQuestion } from "#db/questions/delete.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import {
  addAnswer,
  createAttendee,
  createQuestion,
  createQuestionWithAnswers,
} from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** How many rows one table holds, so a delete's reach is visible. */
const countIn = async (table: string): Promise<number> => {
  const rows = await queryAll<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${table}`,
  );
  return rows[0]?.total ?? 0;
};

/** A question with two answers, assigned to a listing, one answer chosen. */
const seedAnsweredQuestion = async () => {
  const question = await createQuestion("Size?");
  const chosen = await addAnswer(question.id, 0, "S");
  await addAnswer(question.id, 1, "M");
  const listing = await createTestListing();
  await listingQuestions.setIds(listing.id, [question.id]);
  const attendee = await createAttendee(listing.id);
  await saveAttendeeAnswers(new Map([[attendee.id, [chosen.id]]]));
  return { chosen, question };
};

describeWithEnv("db > questions > delete", { db: true }, () => {
  describe("deleteQuestion", () => {
    test("removes the question", async () => {
      const { question } = await seedAnsweredQuestion();
      await deleteQuestion(question.id);
      expect(await countIn("questions")).toBe(0);
    });

    test("takes its answers, its selections and its listing links with it", async () => {
      const { question } = await seedAnsweredQuestion();
      await deleteQuestion(question.id);
      expect(await countIn("answers")).toBe(0);
      expect(await countIn("attendee_answers")).toBe(0);
      expect(await countIn("listing_questions")).toBe(0);
    });

    test("leaves another question's rows alone", async () => {
      const { question } = await seedAnsweredQuestion();
      const other = await createQuestionWithAnswers("Colour?", ["Red"]);
      await deleteQuestion(question.id);
      expect(await countIn("questions")).toBe(1);
      expect(await countIn("answers")).toBe(1);
      expect(other.id).toBeGreaterThan(0);
    });
  });

  describe("deleteAnswer", () => {
    test("removes the answer and the selections pointing at it", async () => {
      const { chosen } = await seedAnsweredQuestion();
      await deleteAnswer(chosen.id);
      expect(await countIn("answers")).toBe(1);
      expect(await countIn("attendee_answers")).toBe(0);
    });

    test("leaves the question it belonged to standing", async () => {
      const { chosen } = await seedAnsweredQuestion();
      await deleteAnswer(chosen.id);
      expect(await countIn("questions")).toBe(1);
    });

    test("leaves the question's listing links alone", async () => {
      const { chosen } = await seedAnsweredQuestion();
      await deleteAnswer(chosen.id);
      expect(await countIn("listing_questions")).toBe(1);
    });
  });
});
