import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import {
  createTestListing,
  describeWithEnv,
  expectFlash,
  getAllActivityLog,
  mockFormRequest,
  mockMultipartRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

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

    test("withSessionAndEntity loads entity after session auth", async () => {
      const { withSessionAndEntity } = await import(
        "#routes/admin/entity-handlers.ts"
      );
      const cookie = await testCookie();

      const response = await withSessionAndEntity((id) =>
        Promise.resolve({ id }),
      )(
        mockRequest("/admin/attendees/1", { headers: { cookie } }),
        123,
      )((request, session, entity) => {
        const path = new URL(request.url).pathname;
        return new Response(`${path}:${entity.id}:${session.userId}`);
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("/admin/attendees/1:123:1");
    });

    test("withAuthAndEntity handles form auth then loads entity", async () => {
      const { withAuthAndEntity } = await import(
        "#routes/admin/entity-handlers.ts"
      );
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await withAuthAndEntity((id) =>
        Promise.resolve({
          id,
        }),
      )(
        mockFormRequest(
          "/admin/attendees/1",
          { csrf_token: csrfToken, value: "ok" },
          cookie,
        ),
        88,
      )(
        (_session, form, entity) =>
          new Response(`${entity.id}:${form.getString("value")}`),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("88:ok");
    });

    test("createEntityRouteHandlers wires GET and POST flows", async () => {
      const { createEntityRouteHandlers } = await import(
        "#routes/admin/entity-handlers.ts"
      );
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handlers = createEntityRouteHandlers(
        (id) => Promise.resolve({ id }),
        (params: { attendeeId: number }) => params.attendeeId,
      );

      const getResponse = await handlers.get(
        (_request, _session, entity) => new Response(`get:${entity.id}`),
      )(mockRequest("/admin/attendees/15", { headers: { cookie } }), {
        attendeeId: 15,
      });
      expect(await getResponse.text()).toBe("get:15");

      const postResponse = await handlers.post(
        (_session, form, entity) =>
          new Response(`post:${entity.id}:${form.getString("name")}`),
      )(
        mockFormRequest(
          "/admin/attendees/16",
          { csrf_token: csrfToken, name: "x" },
          cookie,
        ),
        { attendeeId: 16 },
      );
      expect(await postResponse.text()).toBe("post:16:x");
    });

    test("withAuthEntityHandlers wires GET and POST flows", async () => {
      const { withAuthEntityHandlers } = await import(
        "#routes/admin/entity-handlers.ts"
      );
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handlers = withAuthEntityHandlers((id) => Promise.resolve({ id }));

      const getResponse = await handlers(
        mockRequest("/admin/attendees/33", { headers: { cookie } }),
        33,
      ).get((_request, _session, entity) => new Response(`get:${entity.id}`));
      expect(await getResponse.text()).toBe("get:33");

      const postResponse = await handlers(
        mockFormRequest(
          "/admin/attendees/33",
          { csrf_token: csrfToken, name: "posted" },
          cookie,
        ),
        33,
      ).post(
        (_session, form, entity) =>
          new Response(`post:${entity.id}:${form.getString("name")}`),
      );
      expect(await postResponse.text()).toBe("post:33:posted");
    });

    test("createActionHandler supports custom error mapping", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.reject(new Error("kaboom")),
        message: "unused",
        onError: (error) =>
          new Response(`mapped:${error.message}`, { status: 418 }),
        successRedirect: "/admin/attendees/1",
      });

      const response = await handler(
        mockFormRequest(
          "/admin/attendees/1",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(418);
      expect(await response.text()).toBe("mapped:kaboom");
    });

    test("createActionHandler maps non-Error throws to redirect flashes", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.reject("plain string failure"),
        message: "unused",
        successRedirect: "/admin/attendees/1",
      });

      const response = await handler(
        mockFormRequest(
          "/admin/attendees/1",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "plain string failure", false);
    });

    test("createActionHandler with owner auth and form body redirects on success", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "owner" as const,
        execute: () => Promise.resolve(),
        message: "Owner action completed",
        successRedirect: "/admin/test-owner",
      });

      const response = await handler(
        mockFormRequest("/admin/test-owner", { csrf_token: csrfToken }, cookie),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("/admin/test-owner");
    });

    test("createActionHandler with multipart body and any auth redirects on success", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        bodyMode: "multipart" as const,
        execute: () => Promise.resolve(),
        message: "Multipart action completed",
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
      expect(response.headers.get("location")).toContain(
        "/admin/test-multipart",
      );
    });

    test("createActionHandler with multipart body and owner auth redirects on success", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "owner" as const,
        bodyMode: "multipart" as const,
        execute: () => Promise.resolve(),
        message: "Owner multipart action completed",
        successRedirect: "/admin/test-owner-multipart",
      });

      const response = await handler(
        mockMultipartRequest(
          "/admin/test-owner-multipart",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "/admin/test-owner-multipart",
      );
    });

    test("createActionHandler redacts string secret from activity log", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.resolve(),
        message: "API key sk_test_123 created",
        redactedSecret: "sk_test_123",
        successRedirect: "/admin/keys",
      });

      const response = await handler(
        mockFormRequest("/admin/keys", { csrf_token: csrfToken }, cookie),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "API key sk_test_123 created", true);
    });

    test("createActionHandler redacts dynamic secret from activity log", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.resolve(),
        message: "API key created",
        redactedSecret: (_session, form) =>
          form.getString("api_key") || undefined,
        successRedirect: "/admin/keys",
      });

      const response = await handler(
        mockFormRequest(
          "/admin/keys",
          { api_key: "secret_key_456", csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, "API key created", true);
    });

    test("createActionHandler logs with fixed listingId when configured", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.resolve(),
        listingId: 42,
        message: "Fixed listing action",
        successRedirect: "/admin/fixed-listing",
      });

      const response = await handler(
        mockFormRequest(
          "/admin/fixed-listing",
          { csrf_token: csrfToken },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("Fixed listing action");
      expect(entries[0]?.listing_id).toBe(42);
    });

    test("createActionHandler computes listingId from submitted form", async () => {
      const { createActionHandler } = await import("#routes/admin/actions.ts");
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handler = createActionHandler({
        auth: "any" as const,
        execute: () => Promise.resolve(),
        listingId: (form) => Number.parseInt(form.getString("listing_id"), 10),
        message: "Computed listing action",
        successRedirect: "/admin/computed-listing",
      });

      const response = await handler(
        mockFormRequest(
          "/admin/computed-listing",
          { csrf_token: csrfToken, listing_id: "77" },
          cookie,
        ),
      );

      expect(response.status).toBe(302);
      const entries = await getAllActivityLog();
      expect(entries[0]?.message).toBe("Computed listing action");
      expect(entries[0]?.listing_id).toBe(77);
    });

    test("createConfirmedHandlers handles preValidate rejection and custom notFound", async () => {
      const { createConfirmedHandlers } = await import(
        "#routes/admin/confirmation.ts"
      );
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const handlers = createConfirmedHandlers<{ name: string }>({
        auth: "any",
        identifier: (m) => Promise.resolve(m.name),
        identifierLabel: "Name",
        load: () => Promise.resolve({ name: "Alpha" }),
        onConfirm: () => Promise.resolve(),
        path: "/admin/test/:id/delete",
        preValidate: () =>
          Promise.resolve(
            new Response("blocked", { headers: { "x-hit": "1" }, status: 418 }),
          ),
        render: () => Promise.resolve("ok"),
        successMessage: "deleted",
        successRedirect: "/admin/test",
      });

      const getResponse = await handlers.get(
        mockRequest("/admin/test/1/delete", { headers: { cookie } }),
        1,
      );
      expect(getResponse.status).toBe(418);

      const postResponse = await handlers.post(
        mockFormRequest(
          "/admin/test/1/delete",
          { confirm_identifier: "Alpha", csrf_token: csrfToken },
          cookie,
        ),
        1,
      );
      expect(postResponse.status).toBe(418);

      const missing = createConfirmedHandlers<{ name: string }>({
        auth: "any",
        identifier: (m) => Promise.resolve(m.name),
        identifierLabel: "Name",
        load: () => Promise.resolve(null),
        onConfirm: () => Promise.resolve(),
        onNotFound: () =>
          Promise.resolve(new Response("custom-not-found", { status: 410 })),
        path: "/admin/test/:id/delete",
        render: () => Promise.resolve("ok"),
        successMessage: "deleted",
        successRedirect: "/admin/test",
      });

      const missingResponse = await missing.get(
        mockRequest("/admin/test/999/delete", { headers: { cookie } }),
        999,
      );
      expect(missingResponse.status).toBe(410);
      expect(await missingResponse.text()).toBe("custom-not-found");
    });
  });

  describe("routes/admin/utils.ts", () => {
    test("verifyIdentifier matches case-insensitive trimmed strings", async () => {
      const { verifyIdentifier } = await import(
        "#routes/admin/confirmation.ts"
      );

      expect(verifyIdentifier("Test Listing", "test listing")).toBe(true);
      expect(verifyIdentifier("  Test  ", "test")).toBe(true);
      expect(verifyIdentifier("Test", "Other")).toBe(false);
    });

    test("verifyOrRedirect returns null on match", async () => {
      const { verifyOrRedirect } = await import(
        "#routes/admin/confirmation.ts"
      );

      const form = new FormParams({ confirm_identifier: "Test Listing" });
      const result = verifyOrRedirect(form, "Test Listing", "/admin/test");
      expect(result).toBeNull();
    });

    test("verifyOrRedirect returns error redirect on mismatch without action", async () => {
      const { verifyOrRedirect } = await import(
        "#routes/admin/confirmation.ts"
      );

      const form = new FormParams({ confirm_identifier: "Wrong" });
      const result = verifyOrRedirect(form, "Test Listing", "/admin/test");
      expect(result).not.toBeNull();
      expect(result!.status).toBe(302);
      const location = result!.headers.get("location");
      expect(location).toContain("/admin/test");
    });

    test("verifyOrRedirect returns error redirect with action label", async () => {
      const { verifyOrRedirect } = await import(
        "#routes/admin/confirmation.ts"
      );

      const form = new FormParams({ confirm_identifier: "Wrong" });
      const result = verifyOrRedirect(
        form,
        "Test Listing",
        "/admin/test",
        "Listing name",
        "deletion",
      );
      expect(result).not.toBeNull();
      expectFlash(
        result!,
        "Listing name does not match. Please type the exact listing name to confirm deletion.",
        false,
      );
    });

    test("verifyIdentifierOrJsonError returns null on match", async () => {
      const { verifyIdentifierOrJsonError } = await import(
        "#routes/admin/confirmation.ts"
      );

      expect(
        verifyIdentifierOrJsonError("Test Listing", "Test Listing"),
      ).toBeNull();
    });

    test("verifyIdentifierOrJsonError returns error on mismatch", async () => {
      const { verifyIdentifierOrJsonError } = await import(
        "#routes/admin/confirmation.ts"
      );

      const error = verifyIdentifierOrJsonError(
        "Test Listing",
        "Wrong",
        "Listing name",
      );
      expect(error).toContain("does not match");
      expect(error).toContain("confirm_identifier");
    });

    test("verifyIdentifierOrJsonError handles non-string input", async () => {
      const { verifyIdentifierOrJsonError } = await import(
        "#routes/admin/confirmation.ts"
      );

      const error = verifyIdentifierOrJsonError("Test", null);
      expect(error).not.toBeNull();
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
      expect(response.headers.get("content-disposition")).toContain(
        'filename="test.csv"',
      );
      const body = await response.text();
      expect(body).toBe("name,email\nJohn,john@test.com");
    });

    test("loadAttendeeQuestionData returns undefined for empty attendeeIds", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#shared/db/questions.ts"
      );

      expect(await loadAttendeeQuestionData([1, 2], [])).toBeUndefined();
    });

    test("loadAttendeeQuestionData returns undefined for empty listingIds", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#shared/db/questions.ts"
      );

      expect(await loadAttendeeQuestionData([], [1, 2])).toBeUndefined();
    });

    test("loadAttendeeQuestionData returns undefined when no questions exist", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#shared/db/questions.ts"
      );
      const { createTestAttendeeDirect } = await import("#test-utils");

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
      expect(result).toBeUndefined();
    });

    test("loadAttendeeQuestionData returns question data when questions exist", async () => {
      const { loadAttendeeQuestionData } = await import(
        "#shared/db/questions.ts"
      );
      const { createTestAttendeeDirect } = await import("#test-utils");
      const { answersTable, listingQuestionsTable, questionsTable } =
        await import("#shared/db/questions.ts");

      const listing = await createTestListing({ maxAttendees: 10 });
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Food preference",
      });
      await listingQuestionsTable.insert({
        listingId: listing.id,
        questionId: question.id,
        sortOrder: 0,
      });
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
      expect(result).toBeDefined();
      expect(result!.questions.length).toBe(1);
      expect(result!.questions[0]!.id).toBe(question.id);
      expect(result!.attendeeAnswerMap).toBeDefined();
    });
  });
});
