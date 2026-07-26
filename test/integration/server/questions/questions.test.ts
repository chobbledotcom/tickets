import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setAdminFeatureEnabled } from "#shared/db/admin-features.ts";
import {
  addAnswer,
  createQuestion,
} from "#test/lib/server-questions/helpers.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  createTestManagerSession,
} from "#test-utils/session.ts";
import {
  enableFeature,
  storedFeatureEnabled,
  withFeatureWriteFailure,
} from "#test-utils/settings.ts";

describeWithEnv("server (admin questions)", { db: true }, () => {
  describe("GET /admin/questions", () => {
    testRequiresAuth("/admin/questions");

    test("returns 403 for non-owner", async () => {
      const response = await awaitTestRequest("/admin/questions", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(403)(response);
    });

    test("shows empty questions list", async () => {
      const response = await adminGet("/admin/questions");
      await expectHtmlResponse(response, 200, "Questions");
    });

    test("shows questions when present", async () => {
      await createQuestion("Favorite color?");
      const response = await adminGet("/admin/questions");
      await expectHtmlResponse(response, 200, "Questions", "Favorite color?");
    });

    test("shows a Listings cell titled with the assigned listing names", async () => {
      const qId = await createQuestion("Listings column?");
      const listing = await createTestListing({ name: "Gala Night" });
      const { questionListings } = await import(
        "#shared/db/questions/queries.ts"
      );
      await questionListings.setIds(qId, [listing.id]);

      const response = await adminGet("/admin/questions");
      const body = await response.text();
      expect(body).toContain('title="Gala Night"');
    });
  });

  describe("POST /admin/questions", () => {
    testRequiresAuth("/admin/questions", {
      body: { display_type: "radio" as const, text: "Test?" },
      method: "POST",
    });

    test("creates question and redirects", async () => {
      const id = await createQuestion("What size?");
      expect(id).toBeGreaterThan(0);
      expect(await storedFeatureEnabled("questions")).toBe(true);
    });

    test("does not enable Questions for an invalid create", async () => {
      await setAdminFeatureEnabled("questions", false);
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "radio",
        text: "",
      });
      response.body?.cancel();
      expect(await storedFeatureEnabled("questions")).toBe(false);
    });

    test("does not create a question when enabling the feature fails", async () => {
      await enableFeature("questions");
      await expect(
        withFeatureWriteFailure(async () => {
          await adminFormPost("/admin/questions", {
            display_type: "radio",
            text: "Hidden?",
          });
        }),
      ).rejects.toThrow("feature enable failed");
      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      expect(await getAllQuestionsWithAnswers()).toEqual([]);
    });

    test("redirects to the new question's detail page", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "radio" as const,
        text: "Redirect target?",
      });
      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      const questions = await getAllQuestionsWithAnswers();
      const found = questions.find((q) => q.text === "Redirect target?")!;
      await expectFlashRedirect(
        `/admin/questions/${found.id}`,
        "Question created",
      )(response);
    });

    test("rejects empty text", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "radio" as const,
        text: "",
      });
      // Invalid create bounces back to the questions list with the error flash;
      // the redirect target must be the real path, not an empty string.
      await expectFlashRedirect(
        "/admin/questions",
        expect.stringContaining("Question text is required"),
        false,
      )(response);
    });

    test("requires a display type", async () => {
      // Omitting display_type entirely exercises the field's `required: true`:
      // without it the field-level check is skipped and the picklist validator
      // reports a different message.
      const { response } = await adminFormPost("/admin/questions", {
        text: "No display type?",
      });
      await expectFlashRedirect(
        "/admin/questions",
        expect.stringContaining("Display as is required"),
        false,
      )(response);
    });

    test("creates select questions", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "select" as const,
        text: "Choose one?",
      });
      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      const question = (await getAllQuestionsWithAnswers()).find(
        (q) => q.text === "Choose one?",
      );
      expect(question?.display_type).toBe("select");
      await expectFlashRedirect(
        `/admin/questions/${question!.id}`,
        "Question created",
      )(response);
    });

    test("rejects unsupported display types", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "dropdown",
        text: "Choose one?",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Display as must be radio buttons, a select box, or free text",
        ),
        false,
      );
    });

    test("rejects whitespace-only text", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "radio" as const,
        text: "   ",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Question text is required"),
        false,
      );
    });

    test("rejects text longer than MAX_TEXTAREA_LENGTH server-side", async () => {
      // The browser maxlength is only a UI hint; a direct POST must not be able
      // to persist markdown beyond the cap (it would later be encrypted and
      // rendered on public booking pages).
      const { MAX_TEXTAREA_LENGTH } = await import("#shared/limits.ts");
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "radio" as const,
        text: "a".repeat(MAX_TEXTAREA_LENGTH + 1),
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          `Question text must be ${MAX_TEXTAREA_LENGTH} characters or fewer`,
        ),
        false,
      );

      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      expect(await getAllQuestionsWithAnswers()).toHaveLength(0);
    });
  });

  describe("GET /admin/questions/:id", () => {
    testRequiresAuth("/admin/questions/1", {
      setup: async () => {
        await createQuestion("Detail question?");
      },
    });

    test("returns 404 for non-existent question", async () => {
      const response = await adminGet("/admin/questions/999");
      expectStatus(404)(response);
    });

    test("shows question detail page", async () => {
      const id = await createQuestion("What is your role?");
      const response = await adminGet(`/admin/questions/${id}`);
      await expectHtmlResponse(response, 200, "What is your role?");
    });

    test("shows answers on detail page", async () => {
      const id = await createQuestion("Pick a number");
      const answerId = await addAnswer(id, "One");
      await addAnswer(id, "Two");
      const response = await adminGet(`/admin/questions/${id}`);
      const body = await expectHtmlResponse(response, 200, "One", "Two");
      // Each answer links through to its own edit page.
      expect(body).toContain(
        `<a href="/admin/questions/${id}/answers/${answerId}/edit">One</a>`,
      );
    });
  });

  describe("POST /admin/questions/:id/edit", () => {
    testRequiresAuth("/admin/questions/1/edit", {
      body: { display_type: "radio" as const, text: "Edited" },
      method: "POST",
      setup: async () => {
        await createQuestion("Edit me");
      },
    });

    test("updates question text", async () => {
      const id = await createQuestion("Before edit");
      const { response } = await adminFormPost(`/admin/questions/${id}/edit`, {
        display_type: "radio" as const,
        text: "After edit",
      });
      await expectFlashRedirect(
        `/admin/questions/${id}`,
        "Question updated",
      )(response);

      // Verify the question was updated
      const { questionsTable } = await import("#shared/db/questions/tables.ts");
      const updated = await questionsTable.findById(id);
      expect(updated!.text).toBe("After edit");
    });

    test("does not update a question when enabling the feature fails", async () => {
      const { questionsTable } = await import("#shared/db/questions/tables.ts");
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Before?",
      });
      await enableFeature("questions");
      await expect(
        withFeatureWriteFailure(async () => {
          await adminFormPost(`/admin/questions/${question.id}/edit`, {
            display_type: "radio",
            text: "After?",
          });
        }),
      ).rejects.toThrow("feature enable failed");
      expect((await questionsTable.findById(question.id))?.text).toBe(
        "Before?",
      );
    });

    test("rejects empty text with error page", async () => {
      const id = await createQuestion("Keep me");
      const { response } = await adminFormPost(`/admin/questions/${id}/edit`, {
        display_type: "radio" as const,
        text: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Question text is required"),
        false,
      );
    });

    test("rejects unsupported display types on edit", async () => {
      const id = await createQuestion("Keep me");
      const { response } = await adminFormPost(`/admin/questions/${id}/edit`, {
        display_type: "dropdown",
        text: "Still here",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Display as must be radio buttons, a select box, or free text",
        ),
        false,
      );
    });

    test("keeps a free-text question free-text, ignoring a submitted choice type", async () => {
      const { questionsTable } = await import("#shared/db/questions/tables.ts");
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Notes?",
      });
      const { response } = await adminFormPost(
        `/admin/questions/${q.id}/edit`,
        { display_type: "radio" as const, text: "Notes updated" },
      );
      await expectFlashRedirect(
        `/admin/questions/${q.id}`,
        "Question updated",
      )(response);
      const updated = await questionsTable.findById(q.id);
      expect(updated!.display_type).toBe("free_text");
      expect(updated!.text).toBe("Notes updated");
    });

    test("does not let a choice question be converted to free-text", async () => {
      const id = await createQuestion("Colour?");
      const { questionsTable } = await import("#shared/db/questions/tables.ts");
      await adminFormPost(`/admin/questions/${id}/edit`, {
        display_type: "free_text",
        text: "Colour?",
      });
      const updated = await questionsTable.findById(id);
      expect(updated!.display_type).toBe("radio");
    });

    test("returns 404 for non-existent question on edit", async () => {
      const { response } = await adminFormPost("/admin/questions/999/edit", {
        display_type: "radio" as const,
        text: "Updated",
      });
      expectStatus(404)(response);
    });

    test("redirects with error when question disappears during empty text validation", async () => {
      // Edit with empty text on a non-existent question triggers the requireTextOrError redirect
      const { response } = await adminFormPost("/admin/questions/999/edit", {
        display_type: "radio" as const,
        text: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Question text is required"),
        false,
      );
    });
  });

  describe("question detail page with answer counts", () => {
    test("shows selection totals on question detail page", async () => {
      const qId = await createQuestion("Count Q");
      await addAnswer(qId, "Yes");
      await addAnswer(qId, "No");

      const response = await adminGet(`/admin/questions/${qId}`);
      const body = await response.text();
      // The answers table shows the stored selection total (0 with no bookings).
      expect(body).toContain('<th class="col-quantity">Times Selected</th>');
      expect(body).toContain('<td class="col-quantity">0</td>');
    });
  });
});
