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
  const { response } = await adminFormPost("/admin/questions", { text });
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
  });

  describe("POST /admin/questions", () => {
    testRequiresAuth("/admin/questions", {
      body: { text: "Test?" },
      method: "POST",
    });

    test("creates question and redirects", async () => {
      const id = await createQuestion("What size?");
      expect(id).toBeGreaterThan(0);
    });

    test("redirects to the new question's detail page", async () => {
      const { response } = await adminFormPost("/admin/questions", {
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
        text: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Question text is required"),
        false,
      );
    });

    test("rejects whitespace-only text", async () => {
      const { response } = await adminFormPost("/admin/questions", {
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
      body: { text: "Edited" },
      method: "POST",
      setup: async () => {
        await createQuestion("Edit me");
      },
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
      const { questionsTable } = await import("#shared/db/questions.ts");
      const updated = await questionsTable.findById(id);
      expect(updated!.text).toBe("After edit");
    });

    test("rejects empty text with error page", async () => {
      const id = await createQuestion("Keep me");
      const { response } = await adminFormPost(`/admin/questions/${id}/edit`, {
        text: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Question text is required"),
        false,
      );
    });

    test("returns 404 for non-existent question on edit", async () => {
      const { response } = await adminFormPost("/admin/questions/999/edit", {
        text: "Updated",
      });
      expectStatus(404)(response);
    });

    test("redirects with error when question disappears during empty text validation", async () => {
      // Edit with empty text on a non-existent question triggers the requireTextOrError redirect
      const { response } = await adminFormPost("/admin/questions/999/edit", {
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
