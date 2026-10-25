import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { handleRequest } from "#routes";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import { assertApiDeleteOk, assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("Admin API - Questions", { db: true }, () => {
  describe("GET /api/admin/questions", () => {
    test("lists questions with their answers in display order", async () => {
      await questionsApi().create({ display_type: "radio", text: "First?" });
      const second = await questionsApi().create({
        display_type: "radio",
        text: "Second?",
      });
      await answersApi(second.question.id).create({ text: "Only" });

      await assertJson(apiRequest("/api/admin/questions"), 200, (body) => {
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
      await assertJson(apiRequest("/api/admin/questions"), 200, (body) => {
        expect(body.questions).toEqual([]);
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/questions"));
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/questions/:questionId", () => {
    test("returns one question with its answers", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Shirt size?",
      });
      const small = await answersApi(created.question.id).create({
        text: "Small",
      });
      const large = await answersApi(created.question.id).create({
        text: "Large",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`),
        200,
        (body) => {
          expect(body.question).toEqual({
            // Each child create answers the whole question; the new answer
            // is the list's last.
            answers: [small.question.answers[0], large.question.answers.at(-1)],
            assign_all: false,
            display_type: "radio",
            id: created.question.id,
            text: "Shirt size?",
          });
        },
      );
    });

    test("returns 404 for a non-existent question", async () => {
      await assertJson(
        apiRequest("/api/admin/questions/99999"),
        404,
        (body) => {
          expect(body.error).toBe("Question not found");
        },
      );
    });
  });

  describe("POST /api/admin/questions", () => {
    test("creates a question with no answers", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: { display_type: "radio", text: "Game length?" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.question).toMatchObject({
            answers: [],
            assign_all: false,
            display_type: "radio",
            text: "Game length?",
          });
          expect(body.question.id).toBeGreaterThan(0);
        },
      );
      const all = await getAllQuestionsWithAnswers();
      expect(all.map((question) => question.text)).toEqual(["Game length?"]);
    });

    test("places each new question after the stored ones", async () => {
      const first = await questionsApi().create({
        display_type: "radio",
        text: "First?",
      });
      const second = await questionsApi().create({
        display_type: "radio",
        text: "Second?",
      });
      expect(second.question.id).toBeGreaterThan(first.question.id);
    });

    test("creates a free-text question", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: { display_type: "free_text", text: "Anything else?" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.question.display_type).toBe("free_text");
          expect(body.question.answers).toEqual([]);
        },
      );
    });

    test("assigns the question to every listing when asked", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: {
            assign_all: true,
            display_type: "radio",
            text: "Site-wide?",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.question.assign_all).toBe(true);
        },
      );
    });

    test("returns error when text is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: { display_type: "radio" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("text is required");
        },
      );
    });

    test("returns error when display_type is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: { text: "No type?" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("display_type is required");
        },
      );
    });

    test("returns the form's own refusal for an unknown display type", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: { display_type: "dropdown", text: "Which?" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "Display as must be radio buttons, a select box, or free text",
          );
        },
      );
    });

    test("refuses a text past the form's textarea cap", async () => {
      await assertJson(
        apiRequest("/api/admin/questions", {
          body: {
            display_type: "radio",
            text: "x".repeat(10_241),
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "Question text must be 10240 characters or fewer",
          );
        },
      );
    });
  });

  describe("PUT /api/admin/questions/:questionId", () => {
    test("updates the text and keeps the answers", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Old text?",
      });
      await answersApi(created.question.id).create({ text: "Kept" });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { text: "New text?" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.question.text).toBe("New text?");
          expect(
            body.question.answers.map((a: { text: string }) => a.text),
          ).toEqual(["Kept"]);
        },
      );
    });

    test("switches a choice question between radio and select", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Pick one?",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { display_type: "select" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.question.display_type).toBe("select");
        },
      );
    });

    test("keeps a free-text question free-text whatever the body asks", async () => {
      const created = await questionsApi().create({
        display_type: "free_text",
        text: "Notes?",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { display_type: "radio", text: "Still free?" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.question.display_type).toBe("free_text");
          expect(body.question.text).toBe("Still free?");
        },
      );
    });

    test("keeps a choice question choice when the body asks free text", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Pick one?",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { display_type: "free_text" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.question.display_type).toBe("radio");
        },
      );
    });

    test("moves the question onto every listing", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Assign me?",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { assign_all: true },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.question.assign_all).toBe(true);
        },
      );
    });

    test("returns error when text is missing", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Empty text?",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { text: "" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("text cannot be empty");
        },
      );
    });

    test("returns 404 for a non-existent question", async () => {
      await assertJson(
        apiRequest("/api/admin/questions/99999", {
          body: { text: "Nope?" },
          method: "PUT",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Question not found");
        },
      );
    });
  });

  describe("DELETE /api/admin/questions/:questionId", () => {
    test("deletes a question and its answers", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "To delete?",
      });
      await answersApi(created.question.id).create({ text: "Gone" });

      await assertApiDeleteOk(
        `/api/admin/questions/${created.question.id}`,
        "To delete?",
      );

      expect(await getAllQuestionsWithAnswers()).toEqual([]);
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const created = await questionsApi().create({
        display_type: "radio",
        text: "Protected?",
      });

      await assertJson(
        apiRequest(`/api/admin/questions/${created.question.id}`, {
          body: { confirm_identifier: "Wrong text" },
          method: "DELETE",
        }),
        400,
        (body) => {
          assertStringIncludes(body.error, "does not match");
        },
      );
      expect(await getAllQuestionsWithAnswers()).not.toEqual([]);
    });

    test("returns 404 for a non-existent question", async () => {
      await assertJson(
        apiRequest("/api/admin/questions/99999", {
          body: { confirm_identifier: "anything" },
          method: "DELETE",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Question not found");
        },
      );
    });
  });

  // Question management is owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    test("rejects a manager creating a question with 403 Forbidden", async () => {
      const res = await handleRequest(
        requestAsSession(
          "/api/admin/questions",
          {
            cookie: await createTestManagerSession(),
            csrfToken: await testCsrfToken(),
          },
          {
            body: JSON.stringify({ display_type: "radio", text: "Nope?" }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      expect(res.status).toBe(403);
    });

    test("accepts an owner cookie session", async () => {
      await assertJson(
        handleRequest(
          requestAsSession("/api/admin/questions", {
            cookie: await testCookie(),
            csrfToken: await testCsrfToken(),
          }),
        ),
        200,
      );
    });
  });
});

/** The typed client over the real questions resource, driven through the
 *  in-process transport — the same surface the CLI commands run on. */
const questionsApi = () => ({
  create: async (body: Record<string, unknown>) =>
    (
      await adminApiTestTransport({
        body,
        method: "POST",
        path: "/api/admin/questions",
      })
    ).data as { question: Record<string, unknown> & { id: number } },
});

const answersApi = (questionId: number) => ({
  create: async (body: Record<string, unknown>) =>
    (
      await adminApiTestTransport({
        body,
        method: "POST",
        path: `/api/admin/questions/${questionId}/answers`,
      })
    ).data as { question: { answers: Record<string, unknown>[] } },
});
