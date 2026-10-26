/**
 * Tests for the QR scanner admin feature
 * GET /admin/listing/:id/scanner - Scanner page
 * POST /admin/listing/:id/scan - JSON check-in API
 *
 * Sits beside the story `@story:attendees.checking-people-in-at-the-door`:
 * these own the branch cover, and the requests only a crafted POST can make.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { handleRequest } from "#routes";
import { isJsonApiPath } from "#routes/middleware.ts";
import { signCsrfToken, verifySignedCsrfToken } from "#shared/csrf.ts";
import { SCANNER_CSRF_MAX_AGE_S } from "#shared/limits.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { orphanAttendeeBooking } from "#test-utils/db-fault.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  requestAsSession,
  setupListingAndLogin,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

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
    headers: { "content-type": contentType, host: "localhost" },
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
      ...headers,
      host: "localhost",
    },
    method: "POST",
  });

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

  describe("POST /admin/listing/:id/scan", () => {
    const errorLog = setupErrorSpy();

    test("returns Unknown listing when attendee's listing is deleted", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Frank",
        "frank@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });

      // Point attendee at a non-existent listing to simulate orphan
      await orphanAttendeeBooking(token);

      // Scan from listing B - attendee's listing_id still points to deleted listing A
      const result = await crossListingScanAndGetJson(listingB.id, { token });
      expect(result.status).toBe("wrong_listing");
      expect(result.listingName).toBe("Unknown listing");
    });

    test("returns wrong_listing for attendee from different listing", async () => {
      // Scan token from listing A while on listing B's scanner
      const { listing: listingA, token } = await createTestAttendeeWithToken(
        "Carol",
        "carol@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });
      const result = await crossListingScanAndGetJson(listingB.id, { token });
      expect(result.status).toBe("wrong_listing");
      expect(result.name).toBe("Carol");
      expect(result.listingName).toBe(listingA.name);
    });

    test("returns refunded status for refunded attendee", async () => {
      const { getAttendeesByTokens } = await import("#db/attendees/tokens.ts");
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
      // Admins keep the scanner page open for a whole listing, so its CSRF
      // token gets an extended window. A token well past the standard 1-hour
      // expiry still checks attendees in.
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
      const { getDb } = await import("#db/client.ts");
      const { settings: s } = await import("#db/settings.ts");

      // Remove wrapped_private_key from settings to make key derivation fail
      await getDb().execute({
        args: [],
        sql: "DELETE FROM settings WHERE key = 'wrapped_private_key'",
      });
      s.invalidateCache();

      const { response } = await setupLoginAndScan({ token: "some-token" });
      await assertJson(Promise.resolve(response), 500, (result) => {
        expect(result.error).toBe("Decryption unavailable");
        // The log names the screen the 500 came from.
        const logged = errorLog.contains("Scanner: private key unavailable");
        expect(logged).toBe(true);
      });
    });

    test("force check-in with deleted listing returns not_found", async () => {
      const { token } = await createTestAttendeeWithToken(
        "Eve",
        "eve@test.com",
      );
      const listingB = await createTestListing({ maxAttendees: 10 });

      // Point attendee at a non-existent listing to simulate orphan
      await orphanAttendeeBooking(token);

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
    });
  });
});
