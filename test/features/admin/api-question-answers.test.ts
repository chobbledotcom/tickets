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
} from "#test-utils/admin-api-transport.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const { questions } = ADMIN_API_RESOURCES;

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

    test("returns error when text is missing", async () => {
      const question = await createQuestion("No Text");

      await expectAdminApiError(
        adminApiChildCreate(
          adminApiTestTransport,
          questions,
          "answers",
          question.id,
          {},
        ),
        "text is required (status 400)",
      );
    });

    test("returns 404 for a non-existent question", async () => {
      await expectAdminApiError(
        adminApiChildCreate(
          adminApiTestTransport,
          questions,
          "answers",
          99999,
          { text: "Nope" },
        ),
        "Question not found (status 404)",
      );
    });
  });

  describe("PUT /api/admin/questions/:questionId/answers/:answerId", () => {
    test("renames an answer", async () => {
      const question = await createQuestion("T-shirt size?");
      const created = await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        question.id,
        { text: "Medium" },
      );
      const answerId = created.question.answers[0]!.id;

      const answered = (await adminApiChildCall(
        adminApiTestTransport,
        questions,
        "update",
        "answers",
        question.id,
        answerId,
        { text: "Extra large" },
      )) as typeof created;
      expect(answered.question.answers.map((option) => option.text)).toEqual([
        "Extra large",
      ]);
      assertArrayIncludes(await activityMessages(), [
        `Answer 'Extra large' updated in question ${question.id}`,
      ]);
    });

    test("returns 404 for an unknown question", async () => {
      await expectAdminApiError(
        adminApiChildCall(
          adminApiTestTransport,
          questions,
          "update",
          "answers",
          99999,
          1,
          { text: "Nope" },
        ),
        "Question not found (status 404)",
      );
    });

    test("returns 404 for an answer under another question", async () => {
      const first = await createQuestion("First?");
      const second = await createQuestion("Second?");
      const created = await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        first.id,
        { text: "First's answer" },
      );
      const answerId = created.question.answers[0]!.id;

      await expectAdminApiError(
        adminApiChildCall(
          adminApiTestTransport,
          questions,
          "update",
          "answers",
          second.id,
          answerId,
          { text: "Nope" },
        ),
        "Answer not found (status 404)",
      );
    });
  });

  describe("DELETE /api/admin/questions/:questionId/answers/:answerId", () => {
    test("deletes an answer with a matching confirmation", async () => {
      const question = await createQuestion("Dietary needs?");
      const created = await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        question.id,
        { text: "Vegan" },
      );
      const answerId = created.question.answers[0]!.id;

      const answered = (await adminApiChildCall(
        adminApiTestTransport,
        questions,
        "delete",
        "answers",
        question.id,
        answerId,
        { confirm_identifier: "Vegan" },
      )) as { status: string };
      expect(answered.status).toBe("ok");
      expect((await getQuestionWithAnswers(question.id))!.answers).toEqual([]);
      assertArrayIncludes(await activityMessages(), [
        `Answer 'Vegan' deleted from question ${question.id}`,
      ]);
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const question = await createQuestion("Protected?");
      const created = await adminApiChildCreate(
        adminApiTestTransport,
        questions,
        "answers",
        question.id,
        { text: "Stays" },
      );
      const answerId = created.question.answers[0]!.id;

      await expectAdminApiError(
        adminApiChildCall(
          adminApiTestTransport,
          questions,
          "delete",
          "answers",
          question.id,
          answerId,
          { confirm_identifier: "Wrong" },
        ),
        "Answer text does not match. Please provide the exact answer text in confirm_identifier. (status 400)",
      );
      expect(
        (await getQuestionWithAnswers(question.id))!.answers.map((a) => a.text),
      ).toEqual(["Stays"]);
    });
  });
});
