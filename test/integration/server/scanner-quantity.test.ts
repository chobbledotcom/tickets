/** The scan API's quantity guards: a pick the door cannot admit whole
 * answers before any write, and the counts it does accept land as stored
 * ticket counts. Sits beside the listing-scanner route suite, which owns
 * the page and the auth branches. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import {
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("scan quantity guards", { db: true }, () => {
  /** Create listing + attendee and return session + scan-ready token. */
  const setupScanTest = async (name: string, email: string) => {
    const { listing, token } = await createTestAttendeeWithToken(name, email);
    return {
      listing,
      session: { cookie: await testCookie(), csrfToken: await testCsrfToken() },
      token,
    };
  };

  /** Send a scan request and parse the JSON result. */
  const scanAndGetJson = async (
    listingId: number,
    body: Record<string, unknown>,
    cookie: string,
    csrfToken: string,
  ) =>
    await assertJson(
      handleRequest(
        requestAsSession(
          `/admin/listing/${listingId}/scan`,
          { cookie, csrfToken },
          {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      ),
      200,
    );

  test("refuses a quantity that is not a positive whole number", async () => {
    const { listing, token, session } = await setupScanTest(
      "Quinn",
      "quinn@test.com",
    );

    const response = await handleRequest(
      requestAsSession(
        `/admin/listing/${listing.id}/scan`,
        { cookie: session.cookie, csrfToken: session.csrfToken },
        {
          body: JSON.stringify({ quantity: "two", token }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    await assertJson(Promise.resolve(response), 400, (result) => {
      expect(result.error).toContain("Invalid quantity");
    });
    // Nothing landed: the line still answers not yet checked in.
    const after = await scanAndGetJson(
      listing.id,
      { token },
      session.cookie,
      session.csrfToken,
    );
    expect(after.status).toBe("checked_in");
  });

  test("a line owing exactly one admits straight in with no ask", async () => {
    const { listing, token, session } = await setupScanTest(
      "Solo",
      "solo@test.com",
    );

    const result = await scanAndGetJson(
      listing.id,
      { token },
      session.cookie,
      session.csrfToken,
    );
    expect(result.status).toBe("checked_in");
    expect(result.quantity).toBe(1);
    expect(result.total).toBe(1);
  });
});
