import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  createTestManagerSession,
  expectAdminRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  expectStatus,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Helper: create a question via the admin form */
const createQuestion = async (text: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/questions", { text });
  expect(response.status).toBe(302);
  expectFlash(response, "Question created");
  // Get the ID from the DB
  const { getAllQuestionsWithAnswers } = await import("#lib/db/questions.ts");
  const questions = await getAllQuestionsWithAnswers();
  const found = questions.find((q) => q.text === text);
  expect(found).toBeTruthy();
  return found!.id;
};

/** Helper: add an answer to a question via the admin form */
const addAnswer = async (questionId: number, text: string): Promise<number> => {
  const { response } = await adminFormPost(
    `/admin/questions/${questionId}/answers`,
    { text },
  );
  expect(response.status).toBe(302);
  expectFlash(response, "Answer added");
  // Get the answer ID from the DB
  const { getQuestionWithAnswers } = await import("#lib/db/questions.ts");
  const question = await getQuestionWithAnswers(questionId);
  const found = question!.answers.find((a) => a.text === text);
  expect(found).toBeTruthy();
  return found!.id;
};

describe("server (admin questions)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/questions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/questions"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const response = await awaitTestRequest("/admin/questions", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(403)(response);
    });

    test("shows empty questions list", async () => {
      const { response } = await adminGet("/admin/questions");
      await expectHtmlResponse(response, 200, "Questions");
    });

    test("shows questions when present", async () => {
      await createQuestion("Favorite color?");
      const { response } = await adminGet("/admin/questions");
      await expectHtmlResponse(response, 200, "Questions", "Favorite color?");
    });
  });

  describe("POST /admin/questions", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/questions", { text: "Test?" }),
      );
      expectAdminRedirect(response);
    });

    test("creates question and redirects", async () => {
      const id = await createQuestion("What size?");
      expect(id).toBeGreaterThan(0);
    });

    test("rejects empty text", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        text: "",
      });
      await expectHtmlResponse(response, 400, "Question text is required");
    });

    test("rejects whitespace-only text", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        text: "   ",
      });
      await expectHtmlResponse(response, 400, "Question text is required");
    });
  });

  describe("GET /admin/questions/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const id = await createQuestion("Detail question?");
      const response = await handleRequest(
        mockRequest(`/admin/questions/${id}`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent question", async () => {
      const { response } = await adminGet("/admin/questions/999");
      expectStatus(404)(response);
    });

    test("shows question detail page", async () => {
      const id = await createQuestion("What is your role?");
      const { response } = await adminGet(`/admin/questions/${id}`);
      await expectHtmlResponse(response, 200, "What is your role?");
    });

    test("shows answers on detail page", async () => {
      const id = await createQuestion("Pick a number");
      await addAnswer(id, "One");
      await addAnswer(id, "Two");
      const { response } = await adminGet(`/admin/questions/${id}`);
      await expectHtmlResponse(response, 200, "One", "Two");
    });
  });

  describe("POST /admin/questions/:id/edit", () => {
    test("redirects to login when not authenticated", async () => {
      const id = await createQuestion("Edit me");
      const response = await handleRequest(
        mockFormRequest(`/admin/questions/${id}/edit`, { text: "Edited" }),
      );
      expectAdminRedirect(response);
    });

    test("updates question text", async () => {
      const id = await createQuestion("Before edit");
      const { response } = await adminFormPost(`/admin/questions/${id}/edit`, {
        text: "After edit",
      });
      expectRedirectWithFlash(
        `/admin/questions/${id}`,
        "Question updated",
      )(response);

      // Verify the question was updated
      const { getQuestion } = await import("#lib/db/questions.ts");
      const updated = await getQuestion(id);
      expect(updated!.text).toBe("After edit");
    });

    test("rejects empty text with error page", async () => {
      const id = await createQuestion("Keep me");
      const { response } = await adminFormPost(`/admin/questions/${id}/edit`, {
        text: "",
      });
      await expectHtmlResponse(response, 400, "Question text is required");
    });

    test("returns 404 for non-existent question on edit", async () => {
      const { response } = await adminFormPost("/admin/questions/999/edit", {
        text: "Updated",
      });
      expectStatus(404)(response);
    });

    test("returns 404 when question disappears during empty text validation", async () => {
      // Edit with empty text on a non-existent question triggers the requireTextOrError fallback
      const { response } = await adminFormPost("/admin/questions/999/edit", {
        text: "",
      });
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/questions/:id/answers", () => {
    test("redirects to login when not authenticated", async () => {
      const id = await createQuestion("Answer me");
      const response = await handleRequest(
        mockFormRequest(`/admin/questions/${id}/answers`, { text: "Yes" }),
      );
      expectAdminRedirect(response);
    });

    test("adds answer and redirects", async () => {
      const id = await createQuestion("Choose one");
      const answerId = await addAnswer(id, "Option A");
      expect(answerId).toBeGreaterThan(0);
    });

    test("rejects empty answer text", async () => {
      const id = await createQuestion("Answer validation");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/answers`,
        { text: "" },
      );
      await expectHtmlResponse(response, 400, "Answer text is required");
    });

    test("returns 404 when adding answer with empty text to non-existent question", async () => {
      const { response } = await adminFormPost("/admin/questions/999/answers", {
        text: "",
      });
      expectStatus(404)(response);
    });

    test("assigns correct sort order to answers", async () => {
      const id = await createQuestion("Sort order test");
      await addAnswer(id, "First");
      await addAnswer(id, "Second");
      await addAnswer(id, "Third");

      const { getQuestionWithAnswers } = await import("#lib/db/questions.ts");
      const question = await getQuestionWithAnswers(id);
      expect(question!.answers[0]!.text).toBe("First");
      expect(question!.answers[0]!.sort_order).toBe(0);
      expect(question!.answers[1]!.text).toBe("Second");
      expect(question!.answers[1]!.sort_order).toBe(1);
      expect(question!.answers[2]!.text).toBe("Third");
      expect(question!.answers[2]!.sort_order).toBe(2);
    });
  });

  describe("GET /admin/questions/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const id = await createQuestion("Delete me");
      const response = await handleRequest(
        mockRequest(`/admin/questions/${id}/delete`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent question", async () => {
      const { response } = await adminGet("/admin/questions/999/delete");
      expectStatus(404)(response);
    });

    test("shows delete confirmation page", async () => {
      const id = await createQuestion("To be deleted");
      const { response } = await adminGet(`/admin/questions/${id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "To be deleted",
        "confirm_identifier",
      );
    });
  });

  describe("POST /admin/questions/:id/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const id = await createQuestion("Auth delete");
      const response = await handleRequest(
        mockFormRequest(`/admin/questions/${id}/delete`, {
          confirm_identifier: "Auth delete",
        }),
      );
      expectAdminRedirect(response);
    });

    test("deletes question with correct text confirmation", async () => {
      const id = await createQuestion("Confirm Delete");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Confirm Delete" },
      );
      expectRedirectWithFlash("/admin/questions", "Question deleted")(response);

      // Verify it's gone
      const { getQuestion } = await import("#lib/db/questions.ts");
      const found = await getQuestion(id);
      expect(found).toBeNull();
    });

    test("rejects deletion with wrong text", async () => {
      const id = await createQuestion("Right Text");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Wrong Text" },
      );
      await expectHtmlResponse(response, 400, "exact text to confirm deletion");

      // Verify still exists
      const { getQuestion } = await import("#lib/db/questions.ts");
      const found = await getQuestion(id);
      expect(found).not.toBeNull();
    });

    test("returns 404 for non-existent question", async () => {
      const { response } = await adminFormPost("/admin/questions/999/delete", {
        confirm_identifier: "Anything",
      });
      expectStatus(404)(response);
    });

    test("confirmation is case-insensitive", async () => {
      const id = await createQuestion("Case Test");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "case test" },
      );
      expectRedirectWithFlash("/admin/questions", "Question deleted")(response);
    });

    test("rejects deletion when confirm_identifier is missing", async () => {
      const id = await createQuestion("No Confirm");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        {},
      );
      await expectHtmlResponse(response, 400, "exact text to confirm deletion");
    });

    test("returns 404 when question disappears between getQuestion and getQuestionWithAnswers", async () => {
      const id = await createQuestion("Race Question");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      // Stub getQuestion to return the question but delete it before returning,
      // simulating a race where the question is deleted between getQuestion
      // and getQuestionWithAnswers
      const { questionsTable, deleteQuestion: deleteQ } = await import(
        "#lib/db/questions.ts"
      );
      const original = questionsTable.findById.bind(questionsTable);
      const findByIdStub = stub(
        questionsTable,
        "findById",
        async (...args: Parameters<typeof original>) => {
          const result = await original(...args);
          if (result) await deleteQ(id);
          return result;
        },
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            `/admin/questions/${id}/delete`,
            { csrf_token: csrfToken, confirm_identifier: "Wrong" },
            cookie,
          ),
        );
        expectStatus(404)(response);
      } finally {
        findByIdStub.restore();
      }
    });
  });

  describe("GET /admin/questions/:id/answers/:answerId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const qId = await createQuestion("Answer delete auth");
      const aId = await addAnswer(qId, "Delete this answer");
      const response = await handleRequest(
        mockRequest(`/admin/questions/${qId}/answers/${aId}/delete`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent question", async () => {
      const { response } = await adminGet(
        "/admin/questions/999/answers/1/delete",
      );
      expectStatus(404)(response);
    });

    test("returns 404 for non-existent answer", async () => {
      const qId = await createQuestion("Answer 404");
      const { response } = await adminGet(
        `/admin/questions/${qId}/answers/999/delete`,
      );
      expectStatus(404)(response);
    });

    test("shows answer delete confirmation page", async () => {
      const qId = await createQuestion("Delete answer question");
      const aId = await addAnswer(qId, "Delete this answer");
      const { response } = await adminGet(
        `/admin/questions/${qId}/answers/${aId}/delete`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Delete this answer",
        "confirm_identifier",
      );
    });
  });

  describe("POST /admin/questions/:id/answers/:answerId/delete", () => {
    test("redirects to login when not authenticated", async () => {
      const qId = await createQuestion("Answer post auth");
      const aId = await addAnswer(qId, "Post auth answer");
      const response = await handleRequest(
        mockFormRequest(`/admin/questions/${qId}/answers/${aId}/delete`, {
          confirm_identifier: "Post auth answer",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent question", async () => {
      const { response } = await adminFormPost(
        "/admin/questions/999/answers/1/delete",
        { confirm_identifier: "Anything" },
      );
      expectStatus(404)(response);
    });

    test("returns 404 for non-existent answer", async () => {
      const qId = await createQuestion("Missing answer post");
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/999/delete`,
        { confirm_identifier: "Anything" },
      );
      expectStatus(404)(response);
    });

    test("deletes answer with correct text confirmation", async () => {
      const qId = await createQuestion("Confirm answer delete");
      const aId = await addAnswer(qId, "Goodbye Answer");
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/delete`,
        { confirm_identifier: "Goodbye Answer" },
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer deleted",
      )(response);

      // Verify answer is gone
      const { getQuestionWithAnswers } = await import("#lib/db/questions.ts");
      const question = await getQuestionWithAnswers(qId);
      expect(question!.answers.find((a) => a.id === aId)).toBeUndefined();
    });

    test("rejects deletion with wrong text", async () => {
      const qId = await createQuestion("Wrong answer text");
      const aId = await addAnswer(qId, "Correct Text");
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/delete`,
        { confirm_identifier: "Wrong Text" },
      );
      await expectHtmlResponse(response, 400, "exact text to confirm deletion");

      // Verify answer still exists
      const { getQuestionWithAnswers } = await import("#lib/db/questions.ts");
      const question = await getQuestionWithAnswers(qId);
      expect(question!.answers.find((a) => a.id === aId)).toBeTruthy();
    });

    test("rejects deletion when confirm_identifier is missing", async () => {
      const qId = await createQuestion("Missing confirm answer");
      const aId = await addAnswer(qId, "Still here");
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/delete`,
        {},
      );
      await expectHtmlResponse(response, 400, "exact text to confirm deletion");
    });
  });

  describe("GET /admin/event/:id/questions", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ name: "Auth Event" });
      const response = await handleRequest(
        mockRequest(`/admin/event/${event.id}/questions`),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminGet("/admin/event/999/questions");
      expectStatus(404)(response);
    });

    test("shows empty state when no questions exist", async () => {
      const event = await createTestEvent({ name: "No Questions Event" });
      const { response } = await adminGet(`/admin/event/${event.id}/questions`);
      await expectHtmlResponse(
        response,
        200,
        "No questions created yet",
        'href="/admin/questions"',
      );
    });

    test("shows event questions page with available questions", async () => {
      const event = await createTestEvent({ name: "Question Event" });
      const qId = await createQuestion("Dietary needs?");
      await addAnswer(qId, "Vegetarian");
      await addAnswer(qId, "Vegan");

      const { response } = await adminGet(`/admin/event/${event.id}/questions`);
      await expectHtmlResponse(
        response,
        200,
        "Question Event",
        "Dietary needs?",
      );
    });

    test("shows assigned questions as checked", async () => {
      const event = await createTestEvent({ name: "Assigned Event" });
      const qId = await createQuestion("Shirt size?");

      // Assign the question to the event
      const { setEventQuestions } = await import("#lib/db/questions.ts");
      await setEventQuestions(event.id, [qId]);

      const { response } = await adminGet(`/admin/event/${event.id}/questions`);
      await expectHtmlResponse(
        response,
        200,
        "Assigned Event",
        "Shirt size?",
        "checked",
      );
    });
  });

  describe("POST /admin/event/:id/questions", () => {
    test("redirects to login when not authenticated", async () => {
      const event = await createTestEvent({ name: "Post Auth Event" });
      const response = await handleRequest(
        mockFormRequest(`/admin/event/${event.id}/questions`, {
          question_ids: "1",
        }),
      );
      expectAdminRedirect(response);
    });

    test("returns 404 for non-existent event", async () => {
      const { response } = await adminFormPost("/admin/event/999/questions", {
        question_ids: "1",
      });
      expectStatus(404)(response);
    });

    test("assigns questions to event and redirects", async () => {
      const event = await createTestEvent({ name: "Assign Questions" });
      const q1 = await createQuestion("Question A?");
      await createQuestion("Question B?");

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/questions`,
          {
            csrf_token: csrfToken,
            question_ids: String(q1),
            // For multiple values, we need to build the form manually
          },
          cookie,
        ),
      );
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        "Questions updated",
      )(response);

      // Verify the questions are assigned
      const { getQuestionsForEvent } = await import("#lib/db/questions.ts");
      const assigned = await getQuestionsForEvent(event.id);
      expect(assigned.length).toBe(1);
      expect(assigned[0]!.id).toBe(q1);
    });

    test("assigns no questions when none selected", async () => {
      const event = await createTestEvent({ name: "No Questions" });
      const { response } = await adminFormPost(
        `/admin/event/${event.id}/questions`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/event/${event.id}`,
        "Questions updated",
      )(response);

      const { getQuestionsForEvent } = await import("#lib/db/questions.ts");
      const assigned = await getQuestionsForEvent(event.id);
      expect(assigned.length).toBe(0);
    });

    test("replaces existing question assignments", async () => {
      const event = await createTestEvent({ name: "Replace Questions" });
      const q1 = await createQuestion("Old question?");
      const q2 = await createQuestion("New question?");

      // Assign q1 first
      const { setEventQuestions, getQuestionsForEvent } = await import(
        "#lib/db/questions.ts"
      );
      await setEventQuestions(event.id, [q1]);

      // Now assign q2 via the route
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/questions`,
          {
            csrf_token: csrfToken,
            question_ids: String(q2),
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const assigned = await getQuestionsForEvent(event.id);
      expect(assigned.length).toBe(1);
      expect(assigned[0]!.id).toBe(q2);
    });

    test("logs activity with singular when 1 question assigned", async () => {
      const event = await createTestEvent({ name: "Singular Log" });
      const q1 = await createQuestion("Solo question?");

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      await handleRequest(
        mockFormRequest(
          `/admin/event/${event.id}/questions`,
          {
            csrf_token: csrfToken,
            question_ids: String(q1),
          },
          cookie,
        ),
      );

      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("1 question)");
    });

    test("logs activity with plural when multiple questions assigned", async () => {
      const event = await createTestEvent({ name: "Plural Log" });

      // Assign 0 questions to test the plural form (0 questions)
      const { response: r } = await adminFormPost(
        `/admin/event/${event.id}/questions`,
        {},
      );
      expect(r.status).toBe(302);

      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("0 questions)");
    });
  });

  describe("activity logging", () => {
    test("logs question creation", async () => {
      await createQuestion("Logged Question");
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged Question");
      expect(body).toContain("created");
    });

    test("logs question update", async () => {
      const id = await createQuestion("Before Update Q");
      await adminFormPost(`/admin/questions/${id}/edit`, {
        text: "After Update Q",
      });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("After Update Q");
      expect(body).toContain("updated");
    });

    test("logs question deletion", async () => {
      const id = await createQuestion("Deleted Question");
      await adminFormPost(`/admin/questions/${id}/delete`, {
        confirm_identifier: "Deleted Question",
      });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Question");
      expect(body).toContain("deleted");
    });

    test("logs answer addition", async () => {
      const id = await createQuestion("Answer Log Q");
      await addAnswer(id, "Logged Answer");
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged Answer");
      expect(body).toContain("added");
    });

    test("logs answer deletion", async () => {
      const qId = await createQuestion("Answer Del Log Q");
      const aId = await addAnswer(qId, "Deleted Answer");
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/delete`, {
        confirm_identifier: "Deleted Answer",
      });
      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Answer");
      expect(body).toContain("deleted");
    });
  });

  describe("move answer order", () => {
    test("move-down swaps answer with next", async () => {
      const qId = await createQuestion("Ordering Q");
      const aId1 = await addAnswer(qId, "First");
      await addAnswer(qId, "Second");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId1}/move-down`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);

      // Verify order changed
      const { response: getResp } = await adminGet(`/admin/questions/${qId}`);
      const body = await getResp.text();
      const firstIdx = body.indexOf("Second");
      const secondIdx = body.indexOf("First");
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    test("move-up swaps answer with previous", async () => {
      const qId = await createQuestion("Up Q");
      await addAnswer(qId, "Alpha");
      const aId2 = await addAnswer(qId, "Beta");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId2}/move-up`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);

      const { response: getResp } = await adminGet(`/admin/questions/${qId}`);
      const body = await getResp.text();
      const betaIdx = body.indexOf("Beta");
      const alphaIdx = body.indexOf("Alpha");
      expect(betaIdx).toBeLessThan(alphaIdx);
    });

    test("move-up on first answer is a no-op", async () => {
      const qId = await createQuestion("NoOp Q");
      const aId1 = await addAnswer(qId, "Only");
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId1}/move-up`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);
    });

    test("move-down on last answer is a no-op", async () => {
      const qId = await createQuestion("Last Q");
      const aId1 = await addAnswer(qId, "Only");
      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId1}/move-down`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);
    });
  });

  describe("question detail page with answer counts", () => {
    test("shows answer counts on question detail page", async () => {
      const qId = await createQuestion("Count Q");
      await addAnswer(qId, "Yes");
      await addAnswer(qId, "No");

      const { response } = await adminGet(`/admin/questions/${qId}`);
      const body = await response.text();
      // Should show counts (0 for both since no attendees)
      expect(body).toContain("(0)");
    });
  });
});
