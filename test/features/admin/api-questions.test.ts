import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { handleRequest } from "#routes";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import {
  deleteJson,
  expectApiErrorIncludes,
  expectApiRecord,
  type JsonBody,
  postJson,
  putJson,
  requestAs,
  requestAsManager,
} from "#test-utils/api/admin-json.ts";
import {
  assertApiDeleteOk,
  assertJson,
  expectApiError,
} from "#test-utils/assertions.ts";
import { describeWithQuestions as describeWithEnv } from "#test-utils/feature-suites.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { apiRequest, testCookie, testCsrfToken } from "#test-utils/session.ts";

const QUESTIONS = "/api/admin/questions";

/** The path of one question in the admin API. */
const questionPath = (id: number): string => `${QUESTIONS}/${id}`;

/** The question that an admin API answer holds. */
const expectQuestion = expectApiRecord("question");

const UNKNOWN_DISPLAY_TYPE =
  "Display as must be radio buttons, a select box, or free text";

/** The typed client over the real questions resource, driven through the
 *  in-process transport — the same surface the CLI commands run on. */
const questionsApi = () => ({
  create: async (body: JsonBody) =>
    (
      await adminApiTestTransport({
        body,
        method: "POST",
        path: QUESTIONS,
      })
    ).data as { question: JsonBody & { id: number } },
});

const answersApi = (questionId: number) => ({
  create: async (body: JsonBody) =>
    (
      await adminApiTestTransport({
        body,
        method: "POST",
        path: `${questionPath(questionId)}/answers`,
      })
    ).data as { question: { answers: JsonBody[] } },
});

/** Create one question through the API, shown as `displayType`, and give
 *  back its id. */
const createQuestionId = async (
  text: string,
  displayType = "radio",
): Promise<number> =>
  (await questionsApi().create({ display_type: displayType, text })).question
    .id;

/** Change a new question through the API and check the question that the
 *  answer holds. */
const expectQuestionChange = async (
  created: { displayType?: string; text: string },
  changes: JsonBody,
  check: (question: JsonBody) => void,
): Promise<void> => {
  const id = await createQuestionId(created.text, created.displayType);
  await expectQuestion(putJson(questionPath(id), changes), 200, check);
};

/** Assert that the API refuses a change to a new question with `message`. */
const expectChangeRefused = async (
  changes: JsonBody,
  message: string,
): Promise<void> => {
  const id = await createQuestionId("Refused change?");
  await expectApiError(putJson(questionPath(id), changes), 400, message);
};

/** Assert that the API refuses to create this question with `message`. */
const expectCreateRefused = (body: JsonBody, message: string) =>
  expectApiError(postJson(QUESTIONS, body), 400, message);

describeWithEnv("Admin API - Questions", { db: true }, () => {
  describe("GET /api/admin/questions", () => {
    test("lists questions with their answers in display order", async () => {
      await createQuestionId("First?");
      const second = await createQuestionId("Second?");
      await answersApi(second).create({ text: "Only" });

      await assertJson(apiRequest(QUESTIONS), 200, (body) => {
        expect(body.questions.map((q: { text: string }) => q.text)).toEqual([
          "First?",
          "Second?",
        ]);
        expect(
          body.questions[1].answers.map((a: { text: string }) => a.text),
        ).toEqual(["Only"]);
      });
    });

    test("returns empty array when no questions exist", async () => {
      await assertJson(apiRequest(QUESTIONS), 200, (body) => {
        expect(body.questions).toEqual([]);
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest(QUESTIONS));
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/questions/:questionId", () => {
    test("returns one question with its answers", async () => {
      const id = await createQuestionId("Shirt size?");
      const small = await answersApi(id).create({ text: "Small" });
      const large = await answersApi(id).create({ text: "Large" });

      await expectQuestion(apiRequest(questionPath(id)), 200, (question) => {
        expect(question).toEqual({
          // Each child create answers the whole question; the new answer
          // is the list's last.
          answers: [small.question.answers[0], large.question.answers.at(-1)],
          assign_all: false,
          display_type: "radio",
          id,
          text: "Shirt size?",
        });
      });
    });

    test("returns 404 for a non-existent question", async () => {
      await expectApiError(
        apiRequest(questionPath(99999)),
        404,
        "Question not found",
      );
    });
  });

  describe("POST /api/admin/questions", () => {
    test("creates a question with no answers", async () => {
      await expectQuestion(
        postJson(QUESTIONS, { display_type: "radio", text: "Game length?" }),
        201,
        (question) => {
          expect(question).toMatchObject({
            answers: [],
            assign_all: false,
            display_type: "radio",
            text: "Game length?",
          });
          expect(question.id).toBeGreaterThan(0);
        },
      );
      const all = await getAllQuestionsWithAnswers();
      expect(all.map((question) => question.text)).toEqual(["Game length?"]);
    });

    test("places each new question after the stored ones", async () => {
      const first = await createQuestionId("First?");
      const second = await createQuestionId("Second?");
      expect(second).toBeGreaterThan(first);
    });

    test("creates a free-text question", async () => {
      await expectQuestion(
        postJson(QUESTIONS, {
          display_type: "free_text",
          text: "Anything else?",
        }),
        201,
        (question) => {
          expect(question.display_type).toBe("free_text");
          expect(question.answers).toEqual([]);
        },
      );
    });

    test("assigns the question to every listing when asked", async () => {
      await expectQuestion(
        postJson(QUESTIONS, {
          assign_all: true,
          display_type: "radio",
          text: "Site-wide?",
        }),
        201,
        (question) => expect(question.assign_all).toBe(true),
      );
    });

    test("returns error when text is missing", async () => {
      await expectCreateRefused({ display_type: "radio" }, "text is required");
    });

    test("returns error when display_type is missing", async () => {
      await expectCreateRefused(
        { text: "No type?" },
        "display_type is required",
      );
    });

    test("returns the form's own refusal for an unknown display type", async () => {
      await expectCreateRefused(
        { display_type: "dropdown", text: "Which?" },
        UNKNOWN_DISPLAY_TYPE,
      );
    });

    test("refuses a text past the form's textarea cap", async () => {
      const id = await createQuestionId("Cap?");
      const requests = [
        postJson(QUESTIONS, {
          display_type: "radio",
          text: "x".repeat(10_241),
        }),
        putJson(questionPath(id), { text: "x".repeat(10_241) }),
      ];
      for (const request of requests) {
        await expectApiError(
          request,
          400,
          "Question text must be 10240 characters or fewer",
        );
      }
    });
  });

  describe("PUT /api/admin/questions/:questionId", () => {
    test("updates the text and keeps the answers", async () => {
      const id = await createQuestionId("Old text?");
      await answersApi(id).create({ text: "Kept" });

      await expectQuestion(
        putJson(questionPath(id), { text: "New text?" }),
        200,
        (question) => {
          expect(question.text).toBe("New text?");
          expect(
            (question.answers as { text: string }[]).map((a) => a.text),
          ).toEqual(["Kept"]);
        },
      );
    });

    test("switches a choice question between radio and select", async () => {
      await expectQuestionChange(
        { text: "Pick one?" },
        { display_type: "select" },
        (question) => expect(question.display_type).toBe("select"),
      );
    });

    test("keeps a free-text question free-text whatever the body asks", async () => {
      await expectQuestionChange(
        { displayType: "free_text", text: "Notes?" },
        { display_type: "radio", text: "Still free?" },
        (question) => {
          expect(question.display_type).toBe("free_text");
          expect(question.text).toBe("Still free?");
        },
      );
    });

    test("keeps a choice question choice when the body asks free text", async () => {
      await expectQuestionChange(
        { text: "Pick one?" },
        { display_type: "free_text" },
        (question) => expect(question.display_type).toBe("radio"),
      );
    });

    test("moves the question onto every listing", async () => {
      await expectQuestionChange(
        { text: "Assign me?" },
        { assign_all: true },
        (question) => expect(question.assign_all).toBe(true),
      );
    });

    test("returns error when text is missing", async () => {
      await expectChangeRefused({ text: "" }, "text cannot be empty");
    });

    test("returns the form's own refusal for an unknown display type", async () => {
      await expectChangeRefused(
        { display_type: "dropdown" },
        UNKNOWN_DISPLAY_TYPE,
      );
    });

    test("returns error when assign_all is not a boolean", async () => {
      await expectCreateRefused(
        { assign_all: "yes", display_type: "radio", text: "Bool?" },
        "assign_all must be a boolean",
      );
    });

    test("returns 404 for a non-existent question", async () => {
      await expectApiError(
        putJson(questionPath(99999), { text: "Nope?" }),
        404,
        "Question not found",
      );
    });
  });

  describe("DELETE /api/admin/questions/:questionId", () => {
    test("deletes a question and its answers", async () => {
      const id = await createQuestionId("To delete?");
      await answersApi(id).create({ text: "Gone" });

      await assertApiDeleteOk(questionPath(id), "To delete?");

      expect(await getAllQuestionsWithAnswers()).toEqual([]);
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const id = await createQuestionId("Protected?");

      await expectApiErrorIncludes(
        deleteJson(questionPath(id), { confirm_identifier: "Wrong text" }),
        400,
        "does not match",
      );
      expect(
        (await getAllQuestionsWithAnswers()).map(({ text }) => text),
      ).toEqual(["Protected?"]);
    });

    test("returns 404 for a non-existent question", async () => {
      await expectApiError(
        deleteJson(questionPath(99999), { confirm_identifier: "anything" }),
        404,
        "Question not found",
      );
    });
  });

  // Question management is owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    test("rejects a manager creating a question with 403 Forbidden", async () => {
      const res = await requestAsManager(QUESTIONS, {
        body: { display_type: "radio", text: "Nope?" },
        method: "POST",
      });
      expect(res.status).toBe(403);
    });

    test("accepts an owner cookie session", async () => {
      await assertJson(
        requestAs(
          { cookie: await testCookie(), csrfToken: await testCsrfToken() },
          QUESTIONS,
        ),
        200,
      );
    });
  });
});
