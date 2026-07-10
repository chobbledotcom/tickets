import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { addAnswer, createQuestion } from "./helpers.ts";

describeWithEnv("server (admin questions)", { db: true }, () => {
  describe("POST /admin/questions/:id/answers", () => {
    testRequiresAuth("/admin/questions/1/answers", {
      body: { text: "Yes" },
      method: "POST",
      setup: async () => {
        await createQuestion("Answer me");
      },
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
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Answer text is required"),
        false,
      );
    });

    test("redirects with error when adding answer with empty text to non-existent question", async () => {
      const { response } = await adminFormPost("/admin/questions/999/answers", {
        text: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Answer text is required"),
        false,
      );
    });

    test("returns 404 when adding an answer to a non-existent question", async () => {
      const { response } = await adminFormPost("/admin/questions/999/answers", {
        text: "Orphan option",
      });
      expectStatus(404)(response);
    });

    test("rejects adding an answer to a free-text question", async () => {
      const { questionsTable } = await import("#shared/db/questions/tables.ts");
      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Notes?",
      });
      const { response } = await adminFormPost(
        `/admin/questions/${q.id}/answers`,
        { text: "Ignored option" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Free-text questions don't have answer options",
        ),
        false,
      );
      const question = await getQuestionWithAnswers(q.id);
      expect(question!.answers).toEqual([]);
    });

    test("assigns correct sort order to answers", async () => {
      const id = await createQuestion("Sort order test");
      await addAnswer(id, "First");
      await addAnswer(id, "Second");
      await addAnswer(id, "Third");

      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      const question = await getQuestionWithAnswers(id);
      expect(question!.answers[0]!.text).toBe("First");
      expect(question!.answers[0]!.sort_order).toBe(0);
      expect(question!.answers[1]!.text).toBe("Second");
      expect(question!.answers[1]!.sort_order).toBe(1);
      expect(question!.answers[2]!.text).toBe("Third");
      expect(question!.answers[2]!.sort_order).toBe(2);
    });
  });

  describe("GET /admin/questions/:id/answers/:answerId/delete", () => {
    testRequiresAuth("/admin/questions/1/answers/1/delete", {
      setup: async () => {
        const qId = await createQuestion("Answer delete auth");
        await addAnswer(qId, "Delete this answer");
      },
    });

    test("returns 404 for non-existent question", async () => {
      const response = await adminGet("/admin/questions/999/answers/1/delete");
      expectStatus(404)(response);
    });

    test("returns 404 for non-existent answer", async () => {
      const qId = await createQuestion("Answer 404");
      const response = await adminGet(
        `/admin/questions/${qId}/answers/999/delete`,
      );
      expectStatus(404)(response);
    });

    test("shows answer delete confirmation page", async () => {
      const qId = await createQuestion("Delete answer question");
      const aId = await addAnswer(qId, "Delete this answer");
      const response = await adminGet(
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
    testRequiresAuth("/admin/questions/1/answers/1/delete", {
      body: {
        confirm_identifier: "Post auth answer",
      },
      method: "POST",
      setup: async () => {
        const qId = await createQuestion("Answer post auth");
        await addAnswer(qId, "Post auth answer");
      },
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
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Answer deleted",
      )(response);

      // Verify answer is gone
      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
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
      expect(response.status).toBe(302);
      // The mismatch prompt names the identifier's label ("Answer text"), so an
      // emptied label would leave a nameless " does not match" message.
      expectFlash(
        response,
        expect.stringContaining("Answer text does not match"),
        false,
      );

      // Verify answer still exists
      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
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
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("to confirm deletion"),
        false,
      );
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
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);

      // Verify order changed
      const getResp = await adminGet(`/admin/questions/${qId}`);
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
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);

      const getResp = await adminGet(`/admin/questions/${qId}`);
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
      await expectFlashRedirect(
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
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Answer moved",
      )(response);
    });
  });

  describe("POST /admin/questions/:id/move-up and move-down", () => {
    testRequiresAuth("/admin/questions/1/move-up", {
      body: {},
      method: "POST",
    });

    /** Read the current global question order as a list of texts. */
    const questionOrder = async (): Promise<string[]> => {
      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      return (await getAllQuestionsWithAnswers()).map((q) => q.text);
    };

    test("move-down then move-up reorders the global list", async () => {
      const firstId = await createQuestion("First");
      await createQuestion("Second");
      expect(await questionOrder()).toEqual(["First", "Second"]);

      const down = await adminFormPost(
        `/admin/questions/${firstId}/move-down`,
        {},
      );
      await expectFlashRedirect(
        "/admin/questions",
        "Question moved",
      )(down.response);
      expect(await questionOrder()).toEqual(["Second", "First"]);

      const up = await adminFormPost(`/admin/questions/${firstId}/move-up`, {});
      expect(up.response.status).toBe(302);
      expect(await questionOrder()).toEqual(["First", "Second"]);
    });

    test("moving the last question down is a no-op", async () => {
      await createQuestion("Alpha");
      const lastId = await createQuestion("Beta");

      const { response } = await adminFormPost(
        `/admin/questions/${lastId}/move-down`,
        {},
      );
      expect(response.status).toBe(302);
      expect(await questionOrder()).toEqual(["Alpha", "Beta"]);
    });

    test("returns 404 for a non-existent question", async () => {
      const { response } = await adminFormPost(
        "/admin/questions/999/move-up",
        {},
      );
      expectStatus(404)(response);
    });
  });
});
