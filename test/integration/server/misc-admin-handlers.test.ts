import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ActionHandlerConfig } from "#routes/admin/actions.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

describeWithEnv("server (misc: admin handlers)", { db: true }, () => {
  describe("routes/admin/utils.ts (helper factories)", () => {
    test("withEntityLoader returns handler response when entity exists", async () => {
      const { withEntityLoader } = await import(
        "#routes/admin/entity-handlers.ts"
      );

      const response = await withEntityLoader((id: number) =>
        Promise.resolve(id === 7 ? { id, name: "Loaded" } : null),
      )(7)((entity) => new Response(`entity:${entity.name}`));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("entity:Loaded");
    });

    test("withEntityFromParam returns 404 for invalid ids", async () => {
      const { withEntityFromParam } = await import(
        "#routes/admin/entity-handlers.ts"
      );

      const response = await withEntityFromParam(
        "not-a-number",
        () => Promise.resolve({ id: 1 }),
        () => new Response("ok"),
      );

      expect(response.status).toBe(404);
    });

    const runActionHandler = async (
      config: ActionHandlerConfig,
      path: string,
      fields: Record<string, string> = {},
    ): Promise<Response> => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const handler = createActionHandler(config);
      return handler(
        mockFormRequest(path, { csrf_token: csrfToken, ...fields }, cookie),
      );
    };

    test("createActionHandler supports custom error mapping", async () => {
      const response = await runActionHandler(
        {
          execute: () => Promise.reject(new Error("kaboom")),
          message: "unused",
          onError: (error) =>
            new Response(`mapped:${error.message}`, { status: 418 }),
          pattern: "/admin/attendees",
          successRedirect: "/admin/attendees/1",
        },
        "/admin/attendees/1",
      );

      expect(response.status).toBe(418);
      expect(await response.text()).toBe("mapped:kaboom");
    });

    test("createActionHandler maps non-Error throws to redirect flashes", async () => {
      const response = await runActionHandler(
        {
          execute: () => Promise.reject("plain string failure"),
          message: "unused",
          pattern: "/admin/attendees",
          successRedirect: "/admin/attendees/1",
        },
        "/admin/attendees/1",
      );

      expect(response.status).toBe(302);
      expectFlash(response, "plain string failure", false);
    });

    test("createActionHandler with owner auth and form body redirects on success", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        execute: () => Promise.resolve(),
        message: "Owner action completed",
        pattern: "/admin/backup/create",
        successRedirect: "/admin/test-owner",
      });

      const response = await handler(
        mockFormRequest("/admin/test-owner", { csrf_token: csrfToken }, cookie),
      );

      expect(response.status).toBe(302);
      assertStringIncludes(
        response.headers.get("location") ?? "",
        "/admin/test-owner",
      );
    });

    test("createActionHandler with multipart body redirects on success", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      // The staff route's declaration gives the policy its roles; the body
      // mode and the redirect are the test's own.
      const handler = createActionHandler({
        bodyMode: "multipart" as const,
        execute: () => Promise.resolve(),
        message: "Multipart action completed",
        pattern: "/admin/attendees",
        successRedirect: "/admin/test-multipart",
      });

      const response = await handler(
        mockMultipartRequest(
          "/admin/test-multipart",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      assertStringIncludes(
        response.headers.get("location") ?? "",
        "/admin/test-multipart",
      );
    });

    test("createActionHandler redacts string secret from activity log", async () => {
      const response = await runActionHandler(
        {
          execute: () => Promise.resolve(),
          message: "API key sk_test_123 created",
          pattern: "/admin/attendees",
          redactedSecret: "sk_test_123",
          successRedirect: "/admin/keys",
        },
        "/admin/keys",
      );

      expect(response.status).toBe(302);
      expectFlash(response, "API key sk_test_123 created", true);
      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("API key *** created");
    });

    test("createActionHandler redacts dynamic secret from activity log", async () => {
      const response = await runActionHandler(
        {
          execute: () => Promise.resolve(),
          message: (_session, form) =>
            `API key ${form.getString("api_key")} created`,
          pattern: "/admin/attendees",
          redactedSecret: (_session, form) =>
            form.getString("api_key") || undefined,
          successRedirect: "/admin/keys",
        },
        "/admin/keys",
        { api_key: "secret_key_456" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, "API key secret_key_456 created", true);
      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("API key *** created");
    });

    test("createActionHandler logs with fixed listingId when configured", async () => {
      const response = await runActionHandler(
        {
          execute: () => Promise.resolve(),
          listingId: 42,
          message: "Fixed listing action",
          pattern: "/admin/attendees",
          successRedirect: "/admin/fixed-listing",
        },
        "/admin/fixed-listing",
      );

      expect(response.status).toBe(302);
      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("Fixed listing action");
      expect(entries[0]?.listing_id).toBe(42);
    });

    test("createActionHandler computes listingId from submitted form", async () => {
      const response = await runActionHandler(
        {
          execute: () => Promise.resolve(),
          listingId: (form) =>
            Number.parseInt(form.getString("listing_id"), 10),
          message: "Computed listing action",
          pattern: "/admin/attendees",
          successRedirect: "/admin/computed-listing",
        },
        "/admin/computed-listing",
        { listing_id: "77" },
      );

      expect(response.status).toBe(302);
      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("Computed listing action");
      expect(entries[0]?.listing_id).toBe(77);
    });

    test("getDateFilter returns valid date", async () => {
      const { getDateFilter } = await import("#routes/admin/actions.ts");

      const request = mockRequest("/test?date=2024-01-15");
      expect(getDateFilter(request)).toBe("2024-01-15");
    });

    test("getDateFilter returns null for an invalid date", async () => {
      // Exhaustive date-format coverage lives in the isIsoDate unit test.
      const { getDateFilter } = await import("#routes/admin/actions.ts");

      expect(getDateFilter(mockRequest("/test?date=not-a-date"))).toBeNull();
    });

    test("getDateFilter returns null when absent", async () => {
      const { getDateFilter } = await import("#routes/admin/actions.ts");

      expect(getDateFilter(mockRequest("/test"))).toBeNull();
      expect(getDateFilter(mockRequest("/test?date="))).toBeNull();
    });

    test("getMonthFilter returns valid month", async () => {
      const { getMonthFilter } = await import("#routes/admin/actions.ts");

      expect(getMonthFilter(mockRequest("/test?cal=2026-07"))).toBe("2026-07");
    });

    test("getMonthFilter returns null for invalid format", async () => {
      const { getMonthFilter } = await import("#routes/admin/actions.ts");

      expect(getMonthFilter(mockRequest("/test?cal=2026-7"))).toBeNull();
      expect(getMonthFilter(mockRequest("/test?cal=2026-07-01"))).toBeNull();
      expect(getMonthFilter(mockRequest("/test?cal=not-a-month"))).toBeNull();
    });

    test("getMonthFilter returns null when absent", async () => {
      const { getMonthFilter } = await import("#routes/admin/actions.ts");

      expect(getMonthFilter(mockRequest("/test"))).toBeNull();
      expect(getMonthFilter(mockRequest("/test?cal="))).toBeNull();
    });

    test("csvResponse returns proper CSV response", async () => {
      const { csvResponse } = await import("#routes/admin/actions.ts");

      const response = csvResponse(
        "name,email\nJohn,john@test.com",
        "test.csv",
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/csv; charset=utf-8",
      );
      assertStringIncludes(
        response.headers.get("content-disposition") ?? "",
        'filename="test.csv"',
      );
      const body = await response.text();
      expect(body).toBe("name,email\nJohn,john@test.com");
    });

    test("loadAttendeeQuestionData returns undefined for empty attendeeIds", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#db/questions/attendee-answers/reads.ts"
      );

      expect(await loadAttendeeQuestionData([1, 2], [])).toBe(undefined);
    });

    test("loadAttendeeQuestionData returns undefined for empty listingIds", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#db/questions/attendee-answers/reads.ts"
      );

      expect(await loadAttendeeQuestionData([], [1, 2])).toBe(undefined);
    });

    test("loadAttendeeQuestionData returns undefined when no questions exist", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#db/questions/attendee-answers/reads.ts"
      );
      const { createTestAttendeeDirect } = await import(
        "#test-utils/db-helpers/attendees.ts"
      );

      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Test",
        "test@test.com",
      );

      const result = await loadAttendeeQuestionData(
        [listing.id],
        [attendee.id],
      );
      expect(result).toBe(undefined);
    });

    test("loadAttendeeQuestionData returns question data when questions exist", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#db/questions/attendee-answers/reads.ts"
      );
      const { createTestAttendeeDirect } = await import(
        "#test-utils/db-helpers/attendees.ts"
      );
      const { answersTable, questionsTable } = await import(
        "#db/questions/tables.ts"
      );
      const { questionListings } = await import("#db/questions/queries.ts");

      const listing = await createTestListing({ maxAttendees: 10 });
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Food preference",
      });
      await questionListings.setIds(question.id, [listing.id]);
      await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Veg",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Has Question",
        "has-question@test.com",
      );

      const result = await loadAttendeeQuestionData(
        [listing.id],
        [attendee.id],
      );
      expect(result?.questions.map(({ id }) => id)).toEqual([question.id]);
      expect(result?.attendeeAnswerMap).toEqual(new Map());
    });
  });
});
