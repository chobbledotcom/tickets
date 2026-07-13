import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withPoisonedTransactionExecute } from "#test-utils/db-poison.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import { addAnswer, createQuestion } from "./helpers.ts";

describeWithEnv("server (admin questions)", { db: true }, () => {
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
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Listings updated",
      )(response);

      const { questionListings } = await import(
        "#shared/db/questions/queries.ts"
      );
      expect(await questionListings.getIds(qId)).toEqual([listing.id]);
    });

    test("removes question from unchecked listings", async () => {
      const listing = await createTestListing({ name: "Unassign listing" });
      const qId = await createQuestion("Unassign me?");

      const { questionListings } = await import(
        "#shared/db/questions/queries.ts"
      );
      await questionListings.setIds(qId, [listing.id]);

      const { response } = await adminFormPost(
        `/admin/questions/${qId}/listings`,
        {},
      );
      await expectFlashRedirect(
        `/admin/questions/${qId}`,
        "Listings updated",
      )(response);
      expect(await questionListings.getIds(qId)).toEqual([]);
    });

    test("stores assign-all and logs all-listings assignment", async () => {
      const qId = await createQuestion("Assign everyone?");
      await adminFormPost(`/admin/questions/${qId}/listings`, {
        assign_all: "on",
      });

      const { getQuestionWithAnswers } = await import(
        "#shared/db/questions/queries.ts"
      );
      expect((await getQuestionWithAnswers(qId))!.assign_all).toBe(true);

      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("assigned to all listings");
    });

    test("rolls back assign-all when saving listing links fails", async () => {
      const listing = await createTestListing({ name: "Rollback listing" });
      const qId = await createQuestion("Rollback assignment?");
      const failLinkInsert = withPoisonedTransactionExecute(
        (sql) => sql.includes("INSERT INTO listing_questions"),
        "link insert failed",
      );

      await expect(
        failLinkInsert(async () => {
          await adminFormPost(`/admin/questions/${qId}/listings`, {
            assign_all: "on",
            listing_ids: String(listing.id),
          });
        }),
      ).rejects.toThrow("link insert failed");

      const { getQuestionWithAnswers, questionListings } = await import(
        "#shared/db/questions/queries.ts"
      );
      expect((await getQuestionWithAnswers(qId))!.assign_all).toBe(false);
      expect(await questionListings.getIds(qId)).toEqual([]);
    });

    test("logs singular when assigned to one listing", async () => {
      const listing = await createTestListing({ name: "Singular listing" });
      const qId = await createQuestion("Singular listings log");
      await adminFormPost(`/admin/questions/${qId}/listings`, {
        listing_ids: String(listing.id),
      });

      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("assigned to 1 listing");
      expect(body).not.toContain("assigned to 1 listings");
      // Exact message: the singular suffix is "" (not "s" and not anything
      // else), so `toContain` alone can't catch a corrupted empty suffix.
      const log = await getAllActivityLog(10);
      const entry = log.find((e) => e.message.includes("assigned to"));
      expect(entry?.message).toBe(
        "Question 'Singular listings log' assigned to 1 listing",
      );
    });

    test("logs plural when assigned to zero listings", async () => {
      const qId = await createQuestion("Plural listings log");
      await adminFormPost(`/admin/questions/${qId}/listings`, {});

      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("assigned to 0 listings");
    });
  });

  describe("GET /admin/listing/:id/questions", () => {
    testRequiresAuth("/admin/listing/1/questions", {
      setup: async () => {
        await createTestListing({ name: "Auth Listing" });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/questions");
      expectStatus(404)(response);
    });

    test("shows empty state when no questions exist", async () => {
      const listing = await createTestListing({ name: "No Questions Listing" });
      const response = await adminGet(`/admin/listing/${listing.id}/questions`);
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
      const soloId = await createQuestion("Bringing a plus one?");
      await addAnswer(soloId, "Yes");

      const response = await adminGet(`/admin/listing/${listing.id}/questions`);
      const body = await expectHtmlResponse(
        response,
        200,
        "Question Listing",
        "Dietary needs?",
      );
      // Each question's checkbox summarises its answers, pluralised by count.
      expect(body).toContain("(2 options: Vegetarian, Vegan)");
      expect(body).toContain("(1 option: Yes)");
    });

    test("shows no error box on a plain page load", async () => {
      const listing = await createTestListing({ name: "Calm listing" });
      await createQuestion("Any allergies?");

      const body = await expectHtmlResponse(
        await adminGet(`/admin/listing/${listing.id}/questions`),
        200,
        "Any allergies?",
      );
      // The tab loader once received the framework's page-context object in
      // its `error` parameter, so every load showed an error box reading
      // "[object Object]".
      expect(body).not.toContain("[object Object]");
      expect(body).not.toContain('class="error"');
    });

    test("shows assigned questions as checked", async () => {
      const listing = await createTestListing({ name: "Assigned Listing" });
      const qId = await createQuestion("Shirt size?");

      // Assign the question to the listing
      const { listingQuestions } = await import(
        "#shared/db/questions/queries.ts"
      );
      await listingQuestions.setIds(listing.id, [qId]);

      const response = await adminGet(`/admin/listing/${listing.id}/questions`);
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
    /** Assign `questionIds` to the listing through the router, building the form
     * by hand so more than one id can be sent. */
    const postListingQuestions = async (
      listingId: number,
      questionIds: string,
    ): Promise<Response> => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      return handleRequest(
        mockFormRequest(
          `/admin/listing/${listingId}/questions`,
          { csrf_token: csrfToken, question_ids: questionIds },
          cookie,
        ),
      );
    };

    /** Assert exactly these question ids are assigned to the listing. */
    const expectAssignedQuestionIds = async (
      listingId: number,
      expected: number[],
    ): Promise<void> => {
      const { getListingQuestionIds } = await import(
        "#shared/db/questions/queries.ts"
      );
      expect(await getListingQuestionIds(listingId)).toEqual(expected);
    };

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

      const response = await postListingQuestions(listing.id, String(q1));
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/questions`,
        "Questions updated",
      )(response);

      // Verify the questions are assigned
      await expectAssignedQuestionIds(listing.id, [q1]);
    });

    test("assigns no questions when none selected", async () => {
      const listing = await createTestListing({ name: "No Questions" });
      const { response } = await adminFormPost(
        `/admin/listing/${listing.id}/questions`,
        {},
      );
      await expectFlashRedirect(
        `/admin/listing/${listing.id}/questions`,
        "Questions updated",
      )(response);

      await expectAssignedQuestionIds(listing.id, []);
    });

    test("replaces existing question assignments", async () => {
      const listing = await createTestListing({ name: "Replace Questions" });
      const q1 = await createQuestion("Old question?");
      const q2 = await createQuestion("New question?");

      // Assign q1 first
      const { listingQuestions } = await import(
        "#shared/db/questions/queries.ts"
      );
      await listingQuestions.setIds(listing.id, [q1]);

      // Now assign q2 via the route
      const response = await postListingQuestions(listing.id, String(q2));
      expect(response.status).toBe(302);

      await expectAssignedQuestionIds(listing.id, [q2]);
    });

    test("logs activity with singular when 1 question assigned", async () => {
      const listing = await createTestListing({ name: "Singular Log" });
      const q1 = await createQuestion("Solo question?");

      await postListingQuestions(listing.id, String(q1));

      const response = await adminGet("/admin/log");
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

      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("0 questions)");
    });
  });

  describe("activity logging", () => {
    test("logs question creation", async () => {
      await createQuestion("Logged Question");
      const response = await adminGet("/admin/log");
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
      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("After Update Q");
      expect(body).toContain("updated");
    });

    test("logs question deletion", async () => {
      const id = await createQuestion("Deleted Question");
      await adminFormPost(`/admin/questions/${id}/delete`, {
        confirm_identifier: "Deleted Question",
      });
      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Question");
      expect(body).toContain("deleted");
    });

    test("logs answer addition", async () => {
      const id = await createQuestion("Answer Log Q");
      await addAnswer(id, "Logged Answer");
      const response = await adminGet("/admin/log");
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
      const response = await adminGet("/admin/log");
      const body = await response.text();
      expect(body).toContain("Deleted Answer");
      expect(body).toContain("deleted");
    });
  });
});
