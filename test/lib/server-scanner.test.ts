/**
 * Tests for the QR scanner admin feature
 * GET /admin/listing/:id/scanner - Scanner page
 * POST /admin/listing/:id/scan - JSON check-in API
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { handleRequest } from "#routes";
import { isJsonApiPath } from "#routes/middleware.ts";
import { signCsrfToken, verifySignedCsrfToken } from "#shared/csrf.ts";
import { SCANNER_CSRF_MAX_AGE_S } from "#shared/limits.ts";
import {
  adminGet,
  assertJson,
  awaitTestRequest,
  createTestAttendeeWithToken,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  requestAsSession,
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Create a JSON POST request for the scan API */
const mockScanRequest = (
  listingId: number,
  body: Record<string, unknown>,
  cookie: string,
  csrfToken: string,
): Request =>
  requestAsSession(
    `/admin/listing/${listingId}/scan`,
    { cookie, csrfToken },
    {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );

/** Create listing + attendee and return session + scan-ready token */
const setupScanTest = async (
  name: string,
  email: string,
  listingOverrides = {},
) => {
  const { listing, token } = await createTestAttendeeWithToken(
    name,
    email,
    listingOverrides,
  );
  return {
    listing,
    session: { cookie: await testCookie(), csrfToken: await testCsrfToken() },
    token,
  };
};

/** Send a scan request and parse the JSON result */
const scanAndGetJson = (
  listingId: number,
  body: Record<string, unknown>,
  cookie: string,
  csrfToken: string,
) =>
  assertJson(
    handleRequest(mockScanRequest(listingId, body, cookie, csrfToken)),
    200,
  );

/** Send a scan request using fresh auth cookies (for cross-listing tests) */
const crossListingScanAndGetJson = async (
  listingId: number,
  body: Record<string, unknown>,
) =>
  assertJson(
    handleRequest(
      mockScanRequest(
        listingId,
        body,
        await testCookie(),
        await testCsrfToken(),
      ),
    ),
    200,
  );

/** Create an unauthenticated POST to the scan endpoint */
const unauthScanPost = (
  listingId: number,
  contentType: string,
  body: string,
): Request =>
  new Request(`http://localhost/admin/listing/${listingId}/scan`, {
    body,
    headers: {
      "content-type": contentType,
      host: "localhost",
    },
    method: "POST",
  });

/** Create a scan POST with custom headers (for partial-auth tests) */
const scanPostWithHeaders = (
  listingId: number,
  headers: Record<string, string>,
  body: string,
): Request =>
  new Request(`http://localhost/admin/listing/${listingId}/scan`, {
    body,
    headers: {
      "content-type": "application/json",
      host: "localhost",
      ...headers,
    },
    method: "POST",
  });

/** Get scanner page body text for a given listing */
const getScannerBody = async (listingId: number) => {
  const response = await adminGet(`/admin/listing/${listingId}/scanner`);
  return await response.text();
};

/** Create a test listing and return its scanner page body */
const createListingAndGetScannerBody = async () => {
  const listing = await createTestListing({ maxAttendees: 10 });
  const body = await getScannerBody(listing.id);
  return { body, listing };
};

/** Setup scan test and execute a scan request, returning the response */
const setupAndScan = async (
  name: string,
  email: string,
  bodyOverrides: Record<string, unknown> = {},
  listingOverrides = {},
) => {
  const { listing, token, session } = await setupScanTest(
    name,
    email,
    listingOverrides,
  );
  const body = { token, ...bodyOverrides };
  const response = await handleRequest(
    mockScanRequest(listing.id, body, session.cookie, session.csrfToken),
  );
  return { listing, response, session, token };
};

/** Setup listing with login and send a scan request */
const setupLoginAndScan = async (
  body: Record<string, unknown>,
  csrfTokenOverride?: string,
) => {
  const { listing, ...session } = await setupListingAndLogin({
    maxAttendees: 10,
  });
  const response = await handleRequest(
    mockScanRequest(
      listing.id,
      body,
      session.cookie,
      csrfTokenOverride ?? session.csrfToken,
    ),
  );
  return { listing, response, session };
};

/** Setup listing with login and send a raw scan POST with session-derived headers */
const setupLoginAndRawScan = async (
  headersFn: (s: {
    cookie: string;
    csrfToken: string;
  }) => Record<string, string>,
  body: string,
) => {
  const { listing, ...session } = await setupListingAndLogin({
    maxAttendees: 10,
  });
  const response = await handleRequest(
    scanPostWithHeaders(listing.id, headersFn(session), body),
  );
  return { listing, response, session };
};

/** Point an attendee at a non-existent listing to simulate orphan */
const orphanAttendee = async (token: string) => {
  const { getDb } = await import("#shared/db/client.ts");
  const { computeTicketTokenIndex } = await import("#shared/crypto/hashing.ts");
  const tokenIndex = await computeTicketTokenIndex(token);
  await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = OFF" });
  await getDb().execute({
    args: [tokenIndex],
    sql: `UPDATE listing_attendees
          SET listing_id = 99999
          WHERE attendee_id = (
            SELECT id FROM attendees
            WHERE ticket_token_index = ?
          )`,
  });
  return { getDb };
};

describeWithEnv("QR Scanner", { db: true }, () => {
  describe("isJsonApiPath", () => {
    test("matches scan endpoint with numeric listing ID", () => {
      expect(isJsonApiPath("/admin/listing/123/scan")).toBe(true);
    });

    test("matches scan endpoint with single-digit listing ID", () => {
      expect(isJsonApiPath("/admin/listing/1/scan")).toBe(true);
    });

    test("does not match non-scan admin paths", () => {
      expect(isJsonApiPath("/admin/listing/123/edit")).toBe(false);
    });

    test("does not match paths without listing ID", () => {
      expect(isJsonApiPath("/admin/listing//scan")).toBe(false);
    });

    test("does not match webhook path", () => {
      expect(isJsonApiPath("/payment/webhook")).toBe(false);
    });

    test("does not match with non-numeric listing ID", () => {
      expect(isJsonApiPath("/admin/listing/abc/scan")).toBe(false);
    });
  });

  describe("Content-Type validation for scan endpoint", () => {
    test("accepts JSON content type for scan endpoint", async () => {
      const { response } = await setupLoginAndScan({ token: "nonexistent" });
      // Should not be 400 (Content-Type rejection) - it should process the request
      expect(response.status).not.toBe(400);
    });

    test("rejects non-JSON content type for scan endpoint", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const response = await handleRequest(
        unauthScanPost(
          listing.id,
          "application/x-www-form-urlencoded",
          "token=test",
        ),
      );

      expect(response.status).toBe(400);
    });
  });

  describe("GET /admin/listing/:id/scanner", () => {
    test("renders scanner page when authenticated", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await adminGet(`/admin/listing/${listing.id}/scanner`);

      await expectHtmlResponse(
        response,
        200,
        "Scanner",
        "scanner-container",
        "scanner-video",
        "scanner-start",
        `data-listing-id="${listing.id}"`,
        "scanner.js",
        "scanner-confirm",
      );
    });

    test("redirects to /admin when not authenticated", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/scanner`,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/99999/scanner");
      expect(response.status).toBe(404);
    });

    test("includes manual check-in form with combobox", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const body = await getScannerBody(listing.id);
      expect(body).toContain("Manual Check-in");
      expect(body).toContain("data-manual-checkin");
      expect(body).toContain('id="ticket-options"');
      expect(body).toContain('role="listbox"');
      expect(body).toContain('role="combobox"');
    });

    test("datalist includes unchecked-in attendees", async () => {
      const { listing, token } = await createTestAttendeeWithToken(
        "Alice Unchecked",
        "alice-uc@test.com",
      );
      const body = await getScannerBody(listing.id);
      expect(body).toContain(token);
      expect(body).toContain("Alice Unchecked");
    });

    test("datalist excludes checked-in attendees", async () => {
      const { listing, token, session } = await setupScanTest(
        "Bob Checked",
        "bob-checked@test.com",
      );
      // Check in the attendee
      await handleRequest(
        mockScanRequest(
          listing.id,
          { token },
          session.cookie,
          session.csrfToken,
        ),
      );
      const body = await getScannerBody(listing.id);
      expect(body).not.toContain(token);
    });

    test("datalist excludes refunded attendees", async () => {
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const { listing, token } = await createTestAttendeeWithToken(
        "Carol Refunded",
        "carol-ref@test.com",
      );
      const attendees = await getAttendeesByTokens([token]);
      await postAttendeeRefund({
        attendeeId: attendees[0]!.id,
        listingId: listing.id,
      });
      const body = await getScannerBody(listing.id);
      expect(body).not.toContain(token);
    });

    test("datalist shows attendee quantity", async () => {
      const { listing } = await createTestAttendeeWithToken(
        "Dave Multi",
        "dave-multi@test.com",
        {},
        3,
      );
      const body = await getScannerBody(listing.id);
      expect(body).toContain("3 attendees");
    });

    test("datalist shows singular attendee for quantity 1", async () => {
      const { listing } = await createTestAttendeeWithToken(
        "Eve Single",
        "eve-single@test.com",
      );
      const body = await getScannerBody(listing.id);
      expect(body).toContain("1 attendee)");
    });
  });

  describe("POST /admin/listing/:id/scan", () => {
    test("checks in attendee from same listing", async () => {
      const { response } = await setupAndScan("Alice", "alice@test.com");
      await assertJson(Promise.resolve(response), 200, (result) => {
        expect(result.status).toBe("checked_in");
        expect(result.name).toBe("Alice");
        expect(result.quantity).toBe(1);
      });
    });

    test("returns already_checked_in for checked-in attendee", async () => {
      const { listing, token, session } = await setupAndScan(
        "Bob",
        "bob@test.com",
      );

      // Second scan - already checked in
      const result = await scanAndGetJson(
        listing.id,
        { token },
        session.cookie,
        session.csrfToken,
      );
      expect(result.status).toBe("already_checked_in");
      expect(result.name).toBe("Bob");
      expect(result.quantity).toBe(1);
    });

    test("returns refunded status for refunded attendee", async () => {
      const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
      const { postAttendeeRefund } = await import("#test-utils/ledger.ts");
      const { listing, token, session } = await setupScanTest(
        "Refund",
        "refund@test.com",
      );

      const attendees = await getAttendeesByTokens([token]);
      await postAttendeeRefund({
        attendeeId: attendees[0]!.id,
        listingId: listing.id,
      });

      const result = await scanAndGetJson(
        listing.id,
        { token },
        session.cookie,
        session.csrfToken,
      );
      expect(result.status).toBe("refunded");
      expect(result.name).toBe("Refund");
    });

    test("returns wrong_listing for attendee from different listing", async () => {
      const { listing: listingA, token } = await createTestAttendeeWithToken(
        "Carol",
        "carol@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });

      // Scan token from listing A while on listing B's scanner
      const result = await crossListingScanAndGetJson(listingB.id, { token });
      expect(result.status).toBe("wrong_listing");
      expect(result.name).toBe("Carol");
      expect(result.listingName).toBe(listingA.name);
    });

    test("checks in cross-listing attendee with force flag", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Dave",
        "dave@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });

      // Force check-in from listing B's scanner
      const result = await crossListingScanAndGetJson(listingB.id, {
        force: true,
        token,
      });
      expect(result.status).toBe("checked_in");
      expect(result.name).toBe("Dave");
    });

    test("returns Unknown listing when attendee's listing is deleted", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Frank",
        "frank@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });

      // Point attendee at a non-existent listing to simulate orphan
      const { getDb } = await orphanAttendee(token);
      await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = ON" });

      // Scan from listing B - attendee's listing_id still points to deleted listing A
      const result = await crossListingScanAndGetJson(listingB.id, { token });
      expect(result.status).toBe("wrong_listing");
      expect(result.listingName).toBe("Unknown listing");
    });

    test("returns not_found for invalid token", async () => {
      const { response } = await setupLoginAndScan({
        token: "nonexistent-token",
      });
      await assertJson(Promise.resolve(response), 404, (result) => {
        expect(result.status).toBe("not_found");
      });
    });

    test("returns 401 when not authenticated", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const response = await handleRequest(
        unauthScanPost(
          listing.id,
          "application/json",
          JSON.stringify({ token: "test" }),
        ),
      );

      expect(response.status).toBe(401);
    });

    test("returns 403 for invalid CSRF token", async () => {
      const { response } = await setupLoginAndScan(
        { token: "test" },
        "wrong-csrf-token",
      );

      expect(response.status).toBe(403);
    });

    test("accepts a CSRF token older than the 1-hour default", async () => {
      // Admins keep the scanner page open for a whole listing, so its CSRF token
      // is given an extended window. A token well past the standard 1-hour
      // expiry should still check attendees in.
      const { listing, token, session } = await setupScanTest(
        "Aged",
        "aged@test.com",
      );
      using time = new FakeTime();
      const agedToken = await signCsrfToken();
      // Jump halfway into the scanner window — comfortably past the 1-hour
      // default that every other endpoint enforces.
      time.tick(Math.floor(SCANNER_CSRF_MAX_AGE_S / 2) * 1000);

      // The standard CSRF window would already reject this token...
      expect(await verifySignedCsrfToken(agedToken)).toBe(false);

      // ...but the scanner endpoint still accepts it.
      const result = await scanAndGetJson(
        listing.id,
        { token },
        session.cookie,
        agedToken,
      );
      expect(result.status).toBe("checked_in");
      expect(result.name).toBe("Aged");
    });

    test("returns 400 for missing token in body", async () => {
      const { response } = await setupLoginAndScan({});

      expect(response.status).toBe(400);
    });

    test("returns 403 when x-csrf-token header is absent", async () => {
      const { response } = await setupLoginAndRawScan(
        (s) => ({ cookie: s.cookie }),
        JSON.stringify({ token: "test" }),
      );

      expect(response.status).toBe(403);
    });

    test("returns 400 for malformed JSON body", async () => {
      const { response } = await setupLoginAndRawScan(
        (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrfToken }),
        "not valid json{{{",
      );
      await assertJson(Promise.resolve(response), 400, (result) => {
        expect(result.error).toBe("Invalid request body");
      });
    });

    test("returns 500 when private key is unavailable", async () => {
      const { getDb } = await import("#shared/db/client.ts");
      const { settings: s } = await import("#shared/db/settings.ts");

      // Remove wrapped_private_key from settings to make key derivation fail
      await getDb().execute({
        args: [],
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
      });
      s.invalidateCache();

      const { response } = await setupLoginAndScan({ token: "some-token" });
      await assertJson(Promise.resolve(response), 500, (result) => {
        expect(result.error).toBe("Decryption unavailable");
      });
    });

    test("returns verify_id for non-transferable listing without id_verified", async () => {
      const { response } = await setupAndScan(
        "Alice",
        "alice@test.com",
        {},
        { nonTransferable: true },
      );
      await assertJson(Promise.resolve(response), 200, (result) => {
        expect(result.status).toBe("verify_id");
        expect(result.name).toBe("Alice");
        expect(result.quantity).toBe(1);
      });
    });

    test("checks in non-transferable attendee with id_verified flag", async () => {
      const { response } = await setupAndScan(
        "Bob",
        "bob@test.com",
        { id_verified: true },
        { nonTransferable: true },
      );
      await assertJson(Promise.resolve(response), 200, (result) => {
        expect(result.status).toBe("checked_in");
        expect(result.name).toBe("Bob");
      });
    });

    test("checks in transferable listing without id_verified", async () => {
      const { response } = await setupAndScan("Carol", "carol@test.com");
      await assertJson(Promise.resolve(response), 200, (result) => {
        expect(result.status).toBe("checked_in");
        expect(result.name).toBe("Carol");
      });
    });

    test("force check-in with deleted listing returns not_found", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Eve",
        "eve@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });

      // Point attendee at a non-existent listing to simulate orphan
      const { getDb } = await orphanAttendee(token);

      // Force check-in from listing B — listing 99999 doesn't exist,
      // so no entries can be resolved and check-in returns not_found
      const { response } = await setupLoginAndScan({
        force: true,
        listingId: listingB.id,
        token,
      });
      await assertJson(Promise.resolve(response), 404, (json) => {
        expect(json.status).toBe("not_found");
      });

      await getDb().execute({ args: [], sql: "PRAGMA foreign_keys = ON" });
    });

    test("logs activity when checking in via scanner", async () => {
      const { listing, session } = await setupAndScan("Eve", "eve@test.com");

      // Check activity log
      const logResponse = await awaitTestRequest(
        `/admin/listing/${listing.id}/log`,
        { cookie: session.cookie },
      );
      const logBody = await logResponse.text();
      expect(logBody).toContain("checked in via scanner for 'Test Listing 1'");
    });
  });

  describe("scanner template", () => {
    test("contains CSRF token in meta tag", async () => {
      const { body } = await createListingAndGetScannerBody();
      expect(body).toContain('name="csrf-token"');
    });

    test("contains back link to listing page", async () => {
      const { listing, body } = await createListingAndGetScannerBody();
      expect(body).toContain(`/admin/listing/${listing.id}`);
      expect(body).toContain(listing.name);
    });
  });

  describe("GET /scanner.js", () => {
    test("serves scanner JavaScript bundle", async () => {
      const response = await awaitTestRequest("/scanner.js");

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/javascript",
      );
    });
  });

  describe("listing page scanner link", () => {
    test("listing admin page has scanner link", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const response = await adminGet(`/admin/listing/${listing.id}`);
      const body = await response.text();
      expect(body).toContain(`/admin/listing/${listing.id}/scanner`);
      expect(body).toContain("Scanner");
    });
  });

  describe("GET /admin/guide", () => {
    test("renders guide page when authenticated", async () => {
      const response = await adminGet("/admin/guide");
      await expectHtmlResponse(
        response,
        200,
        "Guide",
        "QR Scanner",
        "How do I use the QR scanner?",
        "scanner check people out",
      );
    });

    test("redirects to /admin when not authenticated", async () => {
      const response = await awaitTestRequest("/admin/guide");

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("documents modifiers and price values", async () => {
      const response = await adminGet("/admin/guide");
      const body = await response.text();

      expect(body).toContain('id="modifiers"');
      expect(body).toContain("What are modifiers?");
      expect(body).toContain("Fixed amount");
      expect(body).toContain("10%");
      expect(body).toContain("10x");
    });

    test("footer contains guide link", async () => {
      const response = await adminGet("/admin/guide");
      const body = await response.text();
      expect(body).toMatch(
        /<a[^>]*\bhref="\/admin\/guide"[^>]*>\s*Guide\s*<\/a>/,
      );
    });
  });
});
