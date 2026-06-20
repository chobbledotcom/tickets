import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
  expectStatus,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

/** Helper: create a question via the admin form */
const createQuestion = async (text: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/questions", {
    display_type: "radio" as const,
    text,
  });
  expect(response.status).toBe(302);
  expectFlash(response, "Question created");
  // Get the ID from the DB
  const { getAllQuestionsWithAnswers } = await import(
    "#shared/db/questions.ts"
  );
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
  const { getQuestionWithAnswers } = await import("#shared/db/questions.ts");
  const question = await getQuestionWithAnswers(questionId);
  const found = question!.answers.find((a) => a.text === text);
  expect(found).toBeTruthy();
  return found!.id;
};

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
      const { response } = await adminGet("/admin/questions");
      await expectHtmlResponse(response, 200, "Questions");
    });

    test("shows questions when present", async () => {
      await createQuestion("Favorite color?");
      const { response } = await adminGet("/admin/questions");
      await expectHtmlResponse(response, 200, "Questions", "Favorite color?");
    });

    test("shows a Listings cell titled with the assigned listing names", async () => {
      const qId = await createQuestion("Listings column?");
      const listing = await createTestListing({ name: "Gala Night" });
      const { setQuestionListings } = await import("#shared/db/questions.ts");
      await setQuestionListings(qId, [listing.id]);

      const { response } = await adminGet("/admin/questions");
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
    });

    test("redirects to the new question's detail page", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "radio" as const,
        text: "Redirect target?",
      });
      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions.ts"
      );
      const questions = await getAllQuestionsWithAnswers();
      const found = questions.find((q) => q.text === "Redirect target?")!;
      expectRedirectWithFlash(
        `/admin/questions/${found.id}`,
        "Question created",
      )(response);
    });

    test("rejects empty text", async () => {
      const { response } = await adminFormPost("/admin/questions", {
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

    test("creates select questions", async () => {
      const { response } = await adminFormPost("/admin/questions", {
        display_type: "select" as const,
        text: "Choose one?",
      });
      const { getAllQuestionsWithAnswers } = await import(
        "#shared/db/questions.ts"
      );
      const question = (await getAllQuestionsWithAnswers()).find(
        (q) => q.text === "Choose one?",
      );
      expect(question?.display_type).toBe("select");
      expectRedirectWithFlash(
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
  });

  describe("GET /admin/questions/:id", () => {
    testRequiresAuth("/admin/questions/1", {
      setup: async () => {
        await createQuestion("Detail question?");
      },
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
      expectRedirectWithFlash(
        `/admin/questions/${id}`,
        "Question updated",
      )(response);

      // Verify the question was updated
      const { questionsTable } = await import("#shared/db/questions.ts");
      const updated = await questionsTable.findById(id);
      expect(updated!.text).toBe("After edit");
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
      const { questionsTable } = await import("#shared/db/questions.ts");
      const q = await questionsTable.insert({
        displayType: "free_text",
        text: "Notes?",
      });
      const { response } = await adminFormPost(
        `/admin/questions/${q.id}/edit`,
        { display_type: "radio" as const, text: "Notes updated" },
      );
      expectRedirectWithFlash(
        `/admin/questions/${q.id}`,
        "Question updated",
      )(response);
      const updated = await questionsTable.findById(q.id);
      expect(updated!.display_type).toBe("free_text");
      expect(updated!.text).toBe("Notes updated");
    });

    test("does not let a choice question be converted to free-text", async () => {
      const id = await createQuestion("Colour?");
      const { questionsTable } = await import("#shared/db/questions.ts");
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

    test("assigns correct sort order to answers", async () => {
      const id = await createQuestion("Sort order test");
      await addAnswer(id, "First");
      await addAnswer(id, "Second");
      await addAnswer(id, "Third");

      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
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

  describe("POST /admin/questions/:id/listings", () => {
    testRequiresAuth("/admin/questions/1/listings", {
      body: { listing_ids: "1" },
      method: "POST",
      setup: async () => {
        await createQuestion("Listings auth question");
      },
    });

    test("returns 404 for non-existent question", async () => {
      const listing = await createTestListing({ name: "Orphan listing" });
      const { response } = await adminFormPost(
        "/admin/questions/999/listings",
        {
          listing_ids: String(listing.id),
        },
      );
      expectStatus(404)(response);
    });

    test("assigns question to a single listing and redirects", async () => {
      const listing = await createTestListing({ name: "Target listing" });
      const qId = await createQuestion("Assign me?");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/listings`,
        { listing_ids: String(listing.id) },
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Listings updated",
      )(response);

      const { getQuestionListingIds } = await import("#shared/db/questions.ts");
      expect(await getQuestionListingIds(qId)).toEqual([listing.id]);
    });

    test("removes question from unchecked listings", async () => {
      const listing = await createTestListing({ name: "Unassign listing" });
      const qId = await createQuestion("Unassign me?");

      const { setQuestionListings, getQuestionListingIds } = await import(
        "#shared/db/questions.ts"
      );
      await setQuestionListings(qId, [listing.id]);

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/listings`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Listings updated",
      )(response);
      expect(await getQuestionListingIds(qId)).toEqual([]);
    });

    test("stores assign-all and logs all-listings assignment", async () => {
      const qId = await createQuestion("Assign everyone?");
      await adminFormPost(`/admin/questions/${qId}/listings`, {
        assign_all: "on",
      });

      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
      );
      expect((await getQuestionWithAnswers(qId))!.assign_all).toBe(true);

      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("assigned to all listings");
    });

    test("logs singular when assigned to one listing", async () => {
      const listing = await createTestListing({ name: "Singular listing" });
      const qId = await createQuestion("Singular listings log");
      await adminFormPost(`/admin/questions/${qId}/listings`, {
        listing_ids: String(listing.id),
      });

      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("assigned to 1 listing");
      expect(body).not.toContain("assigned to 1 listings");
    });

    test("logs plural when assigned to zero listings", async () => {
      const qId = await createQuestion("Plural listings log");
      await adminFormPost(`/admin/questions/${qId}/listings`, {});

      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("assigned to 0 listings");
    });
  });

  describe("GET /admin/questions/:id/delete", () => {
    testRequiresAuth("/admin/questions/1/delete", {
      setup: async () => {
        await createQuestion("Delete me");
      },
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
    testRequiresAuth("/admin/questions/1/delete", {
      body: {
        confirm_identifier: "Auth delete",
      },
      method: "POST",
      setup: async () => {
        await createQuestion("Auth delete");
      },
    });

    test("deletes question with correct text confirmation", async () => {
      const id = await createQuestion("Confirm Delete");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Confirm Delete" },
      );
      expectRedirectWithFlash("/admin/questions", "Question deleted")(response);

      // Verify it's gone
      const { questionsTable } = await import("#shared/db/questions.ts");
      const found = await questionsTable.findById(id);
      expect(found).toBeNull();
    });

    test("rejects deletion with wrong text", async () => {
      const id = await createQuestion("Right Text");
      const { response } = await adminFormPost(
        `/admin/questions/${id}/delete`,
        { confirm_identifier: "Wrong Text" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("to confirm deletion"),
        false,
      );

      // Verify still exists
      const { questionsTable } = await import("#shared/db/questions.ts");
      const found = await questionsTable.findById(id);
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
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("to confirm deletion"),
        false,
      );
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
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer deleted",
      )(response);

      // Verify answer is gone
      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
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
      expectFlash(
        response,
        expect.stringContaining("to confirm deletion"),
        false,
      );

      // Verify answer still exists
      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
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

  describe("answer edit page", () => {
    /** Insert an "answer"-trigger modifier directly and return its id. */
    const createAnswerModifier = async (name: string): Promise<number> => {
      const { modifiersTable } = await import("#shared/db/modifiers.ts");
      const m = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name,
        trigger: "answer",
      });
      return m.id;
    };

    testRequiresAuth("/admin/questions/1/answers/1/edit", {
      setup: async () => {
        const qId = await createQuestion("Answer edit auth");
        await addAnswer(qId, "Editable answer");
      },
    });

    test("returns 404 for a non-existent answer", async () => {
      const qId = await createQuestion("Edit missing answer");
      const { response } = await adminGet(
        `/admin/questions/${qId}/answers/999/edit`,
      );
      expectStatus(404)(response);
    });

    test("shows the edit page with the answer text and modifier option", async () => {
      const qId = await createQuestion("Edit answer page");
      const aId = await addAnswer(qId, "Editable");
      await createAnswerModifier("Surcharge tier");

      const { response } = await adminGet(
        `/admin/questions/${qId}/answers/${aId}/edit`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Editable",
        "Surcharge tier",
        'name="modifier_id"',
      );
    });

    test("updates the answer text and redirects to the question", async () => {
      const qId = await createQuestion("Edit text question");
      const aId = await addAnswer(qId, "Before");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "After" },
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}`,
        "Answer updated",
      )(response);

      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
      );
      const question = await getQuestionWithAnswers(qId);
      expect(question!.answers.find((a) => a.id === aId)!.text).toBe("After");
    });

    test("deactivates an answer when the active box is unchecked", async () => {
      const qId = await createQuestion("Deactivate question");
      const aId = await addAnswer(qId, "Retired option");
      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
      );
      // New answers start active.
      const before = await getQuestionWithAnswers(qId);
      expect(before!.answers.find((a) => a.id === aId)!.active).toBe(true);

      // An unchecked checkbox is simply absent from the POST body.
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        modifier_id: "",
        text: "Retired option",
      });
      const after = await getQuestionWithAnswers(qId);
      expect(after!.answers.find((a) => a.id === aId)!.active).toBe(false);

      // Re-checking it reactivates the answer.
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        active: "on",
        modifier_id: "",
        text: "Retired option",
      });
      const reactivated = await getQuestionWithAnswers(qId);
      expect(reactivated!.answers.find((a) => a.id === aId)!.active).toBe(true);
    });

    test("links the chosen modifier to the answer", async () => {
      const qId = await createQuestion("Link modifier question");
      const aId = await addAnswer(qId, "Large");
      const modifierId = await createAnswerModifier("Large surcharge");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: String(modifierId), text: "Large" },
      );
      expect(response.status).toBe(302);

      const { getAnswerModifierId } = await import("#shared/db/questions.ts");
      expect(await getAnswerModifierId(aId)).toBe(modifierId);
    });

    test("clears the modifier link when none is selected", async () => {
      const qId = await createQuestion("Clear modifier question");
      const aId = await addAnswer(qId, "Plain");
      const modifierId = await createAnswerModifier("Removable");

      const { setAnswerModifier, getAnswerModifierId } = await import(
        "#shared/db/questions.ts"
      );
      await setAnswerModifier(aId, modifierId);
      expect(await getAnswerModifierId(aId)).toBe(modifierId);

      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        modifier_id: "",
        text: "Plain",
      });
      expect(await getAnswerModifierId(aId)).toBeNull();
    });

    test("rejects a modifier id that is not an answer-trigger modifier", async () => {
      const qId = await createQuestion("Invalid modifier question");
      const aId = await addAnswer(qId, "Pick");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "9999", text: "Pick" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid modifier"), false);

      const { getAnswerModifierId } = await import("#shared/db/questions.ts");
      expect(await getAnswerModifierId(aId)).toBeNull();
    });

    test("rejects linking a modifier that isn't answer-triggered", async () => {
      const qId = await createQuestion("Wrong trigger question");
      const aId = await addAnswer(qId, "Pick");
      const { modifiersTable } = await import("#shared/db/modifiers.ts");
      const automatic = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Automatic fee",
        trigger: "automatic",
      });

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: String(automatic.id), text: "Pick" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Invalid modifier"), false);

      const { getAnswerModifierId } = await import("#shared/db/questions.ts");
      expect(await getAnswerModifierId(aId)).toBeNull();
    });

    test("rejects empty answer text", async () => {
      const qId = await createQuestion("Empty edit question");
      const aId = await addAnswer(qId, "Keep me");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Answer text is required"),
        false,
      );
    });

    test("logs the answer update", async () => {
      const qId = await createQuestion("Edit log question");
      const aId = await addAnswer(qId, "Logged before");
      await adminFormPost(`/admin/questions/${qId}/answers/${aId}/edit`, {
        modifier_id: "",
        text: "Logged after",
      });

      const { response } = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Logged after");
      expect(body).toContain("updated");
    });

    test("saves the edited selection total", async () => {
      const qId = await createQuestion("Edit total question");
      const aId = await addAnswer(qId, "Tally");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "Tally", times_selected: "15" },
      );
      expect(response.status).toBe(302);

      const { getAnswerSelectionTotals } = await import(
        "#shared/db/questions.ts"
      );
      expect((await getAnswerSelectionTotals(qId)).get(aId)).toBe(15);
    });

    test("rejects a negative selection total without saving the edit", async () => {
      const qId = await createQuestion("Bad total question");
      const aId = await addAnswer(qId, "Before");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        { modifier_id: "", text: "After", times_selected: "-3" },
      );
      expect(response.status).toBe(302);

      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions.ts"
      );
      const question = await getQuestionWithAnswers(qId);
      // The invalid aggregate aborts the whole edit, so the text is unchanged.
      expect(question!.answers.find((a) => a.id === aId)!.text).toBe("Before");
    });
  });

  describe("answer recalculate page", () => {
    /** Book an attendee on a listing and point them at the answer, so the
     * answer has one real selection to recalculate against. */
    const bookAnswer = async (
      listingId: number,
      answerId: number,
    ): Promise<void> => {
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const { saveAttendeeAnswers } = await import("#shared/db/questions.ts");
      const result = await createAttendeeAtomic({
        bookings: [{ listingId }],
        email: "booker@test.com",
        name: "Booker",
      });
      if (!result.success) throw new Error("Failed to create attendee");
      await saveAttendeeAnswers(
        new Map([[result.attendees[0]!.id, [answerId]]]),
      );
    };

    testRequiresAuth("/admin/questions/1/answers/1/recalculate", {
      setup: async () => {
        const qId = await createQuestion("Recalc auth");
        await addAnswer(qId, "Answer");
      },
    });

    test("returns 404 for a non-existent answer", async () => {
      const qId = await createQuestion("Recalc missing");
      const { response } = await adminGet(
        `/admin/questions/${qId}/answers/999/recalculate`,
      );
      expectStatus(404)(response);
    });

    test("shows the stored and recalculated totals", async () => {
      const qId = await createQuestion("Recalc page");
      const aId = await addAnswer(qId, "Pick");
      const listing = await createTestListing();
      await bookAnswer(listing.id, aId);

      const { updateAnswerAggregateValues } = await import(
        "#shared/db/questions.ts"
      );
      await updateAnswerAggregateValues(aId, { times_selected: 8 });

      const { response } = await adminGet(
        `/admin/questions/${qId}/answers/${aId}/recalculate`,
      );
      const body = await response.text();
      expect(response.status).toBe(200);
      // Stored (8) and the value rebuilt from the single booking (1).
      expect(body).toContain("<td>8</td>");
      expect(body).toContain("<td>1</td>");
      expect(body).toContain(
        `action="/admin/questions/${qId}/answers/${aId}/recalculate"`,
      );
    });

    test("re-renders with a prompt when no field is selected", async () => {
      const qId = await createQuestion("Recalc none");
      const aId = await addAnswer(qId, "Pick");

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/recalculate`,
        {},
      );
      const body = await response.text();
      expect(response.status).toBe(400);
      expect(body).toContain("Choose at least one total to recalculate");
    });

    test("resets the stored total from attendee answers and redirects", async () => {
      const qId = await createQuestion("Recalc reset");
      const aId = await addAnswer(qId, "Pick");
      const listing = await createTestListing();
      await bookAnswer(listing.id, aId);

      const { updateAnswerAggregateValues, getAnswerSelectionTotals } =
        await import("#shared/db/questions.ts");
      await updateAnswerAggregateValues(aId, { times_selected: 99 });

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/answers/${aId}/recalculate`,
        { recalculate_fields: "times_selected" },
      );
      expectRedirectWithFlash(
        `/admin/questions/${qId}/answers/${aId}/edit`,
        "Selection total recalculated",
      )(response);
      expect((await getAnswerSelectionTotals(qId)).get(aId)).toBe(1);
    });
  });

  describe("GET /admin/listing/:id/questions", () => {
    testRequiresAuth("/admin/listing/1/questions", {
      setup: async () => {
        await createTestListing({ name: "Auth Listing" });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminGet("/admin/listing/999/questions");
      expectStatus(404)(response);
    });

    test("shows empty state when no questions exist", async () => {
      const listing = await createTestListing({ name: "No Questions Listing" });
      const { response } = await adminGet(
        `/admin/listing/${listing.id}/questions`,
      );
      await expectHtmlResponse(
        response,
        200,
        "No questions created yet",
        'href="/admin/questions"',
      );
    });

    test("shows listing questions page with available questions", async () => {
      const listing = await createTestListing({ name: "Question Listing" });
      const qId = await createQuestion("Dietary needs?");
      await addAnswer(qId, "Vegetarian");
      await addAnswer(qId, "Vegan");

      const { response } = await adminGet(
        `/admin/listing/${listing.id}/questions`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Question Listing",
        "Dietary needs?",
      );
    });

    test("shows assigned questions as checked", async () => {
      const listing = await createTestListing({ name: "Assigned Listing" });
      const qId = await createQuestion("Shirt size?");

      // Assign the question to the listing
      const { setListingQuestions } = await import("#shared/db/questions.ts");
      await setListingQuestions(listing.id, [qId]);

      const { response } = await adminGet(
        `/admin/listing/${listing.id}/questions`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Assigned Listing",
        "Shirt size?",
        "checked",
      );
    });
  });

  describe("POST /admin/listing/:id/questions", () => {
    testRequiresAuth("/admin/listing/1/questions", {
      body: {
        question_ids: "1",
      },
      method: "POST",
      setup: async () => {
        await createTestListing({ name: "Post Auth Listing" });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const { response } = await adminFormPost("/admin/listing/999/questions", {
        question_ids: "1",
      });
      expectStatus(404)(response);
    });

    test("assigns questions to listing and redirects", async () => {
      const listing = await createTestListing({ name: "Assign Questions" });
      const q1 = await createQuestion("Question A?");
      await createQuestion("Question B?");

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/questions`,
          {
            csrf_token: csrfToken,
            question_ids: String(q1),
            // For multiple values, we need to build the form manually
          },
          cookie,
        ),
      );
      expectRedirectWithFlash(
        `/admin/listing/${listing.id}`,
        "Questions updated",
      )(response);

      // Verify the questions are assigned
      const { getListingQuestionIds } = await import("#shared/db/questions.ts");
      const assigned = await getListingQuestionIds(listing.id);
      expect(assigned.length).toBe(1);
      expect(assigned[0]).toBe(q1);
    });

    test("assigns no questions when none selected", async () => {
      const listing = await createTestListing({ name: "No Questions" });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/questions`,
        {},
      );
      expectRedirectWithFlash(
        `/admin/listing/${listing.id}`,
        "Questions updated",
      )(response);

      const { getListingQuestionIds } = await import("#shared/db/questions.ts");
      const assigned = await getListingQuestionIds(listing.id);
      expect(assigned.length).toBe(0);
    });

    test("replaces existing question assignments", async () => {
      const listing = await createTestListing({ name: "Replace Questions" });
      const q1 = await createQuestion("Old question?");
      const q2 = await createQuestion("New question?");

      // Assign q1 first
      const { setListingQuestions, getListingQuestionIds } = await import(
        "#shared/db/questions.ts"
      );
      await setListingQuestions(listing.id, [q1]);

      // Now assign q2 via the route
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/questions`,
          {
            csrf_token: csrfToken,
            question_ids: String(q2),
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);

      const assigned = await getListingQuestionIds(listing.id);
      expect(assigned.length).toBe(1);
      expect(assigned[0]).toBe(q2);
    });

    test("logs activity with singular when 1 question assigned", async () => {
      const listing = await createTestListing({ name: "Singular Log" });
      const q1 = await createQuestion("Solo question?");

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      await handleRequest(
        mockFormRequest(
          `/admin/listing/${listing.id}/questions`,
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
      const listing = await createTestListing({ name: "Plural Log" });

      // Assign 0 questions to test the plural form (0 questions)
      const { response: r } = await adminFormPost(
        `/admin/listing/${listing.id}/questions`,
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
        display_type: "radio" as const,
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
    test("shows selection totals on question detail page", async () => {
      const qId = await createQuestion("Count Q");
      await addAnswer(qId, "Yes");
      await addAnswer(qId, "No");

      const { response } = await adminGet(`/admin/questions/${qId}`);
      const body = await response.text();
      // The answers table shows the stored selection total (0 with no bookings).
      expect(body).toContain("<th>Times Selected</th>");
      expect(body).toContain("<td>0</td>");
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
        "#shared/db/questions.ts"
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
      expectRedirectWithFlash(
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
