import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getQuestionWithAnswers } from "#db/questions/queries.ts";
import { questionsTable } from "#db/questions/tables.ts";
import {
  adminApiChildCall,
  adminApiChildCreate,
} from "#shared/admin-api-client.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  adminApiTestTransport,
  expectAdminApiError,
  expectTextChildCreateRefusals,
} from "#test-utils/admin-api-transport.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const { questions } = ADMIN_API_RESOURCES;

/** Add one answer to a question through the client. */
const addAnswer = (questionId: number, body: { text: string }) =>
  adminApiChildCreate(
    adminApiTestTransport,
    questions,
    "answers",
    questionId,
    body,
  );

/** Add one answer and name the id it was stored under. */
const addAnswerTo = async (questionId: number, text: string) => {
  const created = await addAnswer(questionId, { text });
  return { answerId: created.question.answers[0]!.id, created };
};

/** A new question holding one answer. */
const questionWithAnswer = async (questionText: string, answerText: string) => {
  const question = await createQuestion(questionText);
  return { ...(await addAnswerTo(question.id, answerText)), question };
};

/** One update or delete on an answer's own route through the client. */
const answerCall = (
  action: "delete" | "update",
  questionId: number,
  answerId: number,
  body: unknown,
) =>
  adminApiChildCall(
    adminApiTestTransport,
    questions,
    action,
    "answers",
    questionId,
    answerId,
    body,
  );

/** Create one question row directly, so the child routes always have a
 *  parent whose display type the test chose. */
const createQuestion = (
  text: string,
  displayType: "free_text" | "radio" = "radio",
) => questionsTable.insert({ displayType, text });

describeWithEnv("Admin API - Question answers", { db: true }, () => {
  describe("POST /api/admin/questions/:questionId/answers", () => {
    test("appends an answer and returns the question with it", async () => {
      const question = await createQuestion("Game length?");

      const answered = await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        question.id,
        { text: "20-30 minutes" },
      );
      expect(answered.question.answers.map((option) => option.text)).toEqual([
        "20-30 minutes",
      ]);
      assertArrayIncludes(await activityMessages(), [
        `Answer '20-30 minutes' added to question ${question.id}`,
      ]);
    });

    test("appends the new answer after the stored ones", async () => {
      const question = await createQuestion("Player count?");
      await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        question.id,
        { text: "2 players" },
      );
      const answered = await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        question.id,
        { text: "4 players" },
      );
      expect(answered.question.answers.map((option) => option.text)).toEqual([
        "2 players",
        "4 players",
      ]);
    });

    test("refuses an answer on a free-text question", async () => {
      const question = await createQuestion("Anything else?", "free_text");

      await expectAdminApiError(
        adminApiChildCreate(
          adminApiTestTransport,
          questions,
          "answers",
          question.id,
          { text: "Nope" },
        ),
        "Free-text questions don't have answer options. (status 400)",
      );
      expect((await getQuestionWithAnswers(question.id))!.answers).toEqual([]);
    });

    test("refuses a missing text, an over-long text, and an unknown question", async () => {
      const question = await createQuestion("No Text");

      await expectTextChildCreateRefusals(questions, "answers", question.id, [
        {
          body: { text: "x".repeat(251) },
          message: "Answer text must be 250 characters or fewer (status 400)",
          parentId: question.id,
        },
      ]);
    });
  });

  describe("PUT /api/admin/questions/:questionId/answers/:answerId", () => {
    test("renames an answer", async () => {
      const { answerId, created, question } = await questionWithAnswer(
        "T-shirt size?",
        "Medium",
      );

      const answered = (await answerCall("update", question.id, answerId, {
        text: "Extra large",
      })) as typeof created;
      expect(answered.question.answers.map((option) => option.text)).toEqual([
        "Extra large",
      ]);
      assertArrayIncludes(await activityMessages(), [
        `Answer 'Extra large' updated in question ${question.id}`,
      ]);
    });

    test("returns 404 for an unknown question", async () => {
      await expectAdminApiError(
        answerCall("update", 99999, 1, { text: "Nope" }),
        "Question not found (status 404)",
      );
    });

    test("returns 404 for an answer under another question", async () => {
      const first = await createQuestion("First?");
      const second = await createQuestion("Second?");
      const { answerId } = await addAnswerTo(first.id, "First's answer");

      await expectAdminApiError(
        answerCall("update", second.id, answerId, { text: "Nope" }),
        "Answer not found (status 404)",
      );
    });
  });

  describe("DELETE /api/admin/questions/:questionId/answers/:answerId", () => {
    test("deletes an answer with a matching confirmation", async () => {
      const { answerId, question } = await questionWithAnswer(
        "Dietary needs?",
        "Vegan",
      );

      const answered = (await answerCall("delete", question.id, answerId, {
        confirm_identifier: "Vegan",
      })) as { status: string };
      expect(answered.status).toBe("ok");
      expect((await getQuestionWithAnswers(question.id))!.answers).toEqual([]);
      assertArrayIncludes(await activityMessages(), [
        `Answer 'Vegan' deleted from question ${question.id}`,
      ]);
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const { answerId, question } = await questionWithAnswer(
        "Protected?",
        "Stays",
      );

      await expectAdminApiError(
        answerCall("delete", question.id, answerId, {
          confirm_identifier: "Wrong",
        }),
        "Answer text does not match. Please provide the exact answer text in confirm_identifier. (status 400)",
      );
      expect(
        (await getQuestionWithAnswers(question.id))!.answers.map((a) => a.text),
      ).toEqual(["Stays"]);
    });
  });
});
