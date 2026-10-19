/** The scanner's offline ticket list: the door's own tokens for the scanner
 * page to save on load. A door role reads its scope's list, a staff-only
 * role is refused before the door is looked up, and a "No check-in" listing
 * hands out nothing. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendeeDirect,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  createTestEditorSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";
import { groupDoor } from "./support.ts";

/** The door's token list, fetched the way the scanner page fetches it. */
const tokensAsScanner = async (
  path: string,
  cookie: string,
): Promise<{ json: Record<string, unknown>; status: number }> => {
  const response = await handleRequest(
    requestAsSession(path, { cookie, csrfToken: await testCsrfToken() }),
  );
  return {
    json: (await response.json()) as Record<string, unknown>,
    status: response.status,
  };
};

describeWithEnv("the scanner's offline ticket list", { db: true }, () => {
  test("a listing door's list carries its ticket tokens", async () => {
    const first = await createTestAttendeeWithToken("Pia", "pia@example.com", {
      name: "Quiz door",
    });
    const { cookie } = await createTestScannerSession();
    const second = await createTestAttendeeDirect(
      first.listing.id,
      "Aki",
      "aki@example.com",
    );

    const { json, status } = await tokensAsScanner(
      `/admin/listing/${first.listing.id}/scan-tokens`,
      cookie,
    );
    expect(status).toBe(200);
    expect(json).toEqual({ tokens: [first.token, second.token].sort() });
  });

  test("a listing with no tickets answers an empty list", async () => {
    const listing = await createTestListing({ name: "Empty door" });
    const { cookie } = await createTestScannerSession();

    const { json, status } = await tokensAsScanner(
      `/admin/listing/${listing.id}/scan-tokens`,
      cookie,
    );
    expect(status).toBe(200);
    expect(json).toEqual({ tokens: [] });
  });

  test("an unknown listing answers 404", async () => {
    const { cookie } = await createTestScannerSession();

    const { json, status } = await tokensAsScanner(
      "/admin/listing/999999/scan-tokens",
      cookie,
    );
    expect(status).toBe(404);
    expect(json).toEqual({ status: "not_found" });
  });

  test("a 'No check-in' listing answers 404 even with tickets", async () => {
    const listing = await createTestListing({
      name: "Merch stand",
      purchaseOnly: true,
    });
    await createTestAttendeeDirect(listing.id, "Pia", "pia@example.com");
    const { cookie } = await createTestScannerSession();

    const { json, status } = await tokensAsScanner(
      `/admin/listing/${listing.id}/scan-tokens`,
      cookie,
    );
    expect(status).toBe(404);
    expect(json).toEqual({ status: "not_found" });
  });

  test("a group door's list spans its members and skips 'No check-in' ones", async () => {
    const { group, members } = await groupDoor(2, {}, [
      "Quiz door",
      "Talk door",
    ]);
    const shop = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Shop door",
      purchaseOnly: true,
    });
    const { token: quizToken } = await createTestAttendeeDirect(
      members[0]!.id,
      "Pia",
      "pia@example.com",
    );
    const { token: talkToken } = await createTestAttendeeDirect(
      members[1]!.id,
      "Aki",
      "aki@example.com",
    );
    const { token: shopToken } = await createTestAttendeeDirect(
      shop.id,
      "Noor",
      "noor@example.com",
    );
    const { cookie } = await createTestScannerSession();

    const { json, status } = await tokensAsScanner(
      `/admin/groups/${group.id}/scan-tokens`,
      cookie,
    );
    expect(status).toBe(200);
    expect(quizToken).not.toBe(talkToken);
    expect(shopToken).toMatch(/^[0-9A-F]{10}$/);
    expect(json).toEqual({ tokens: [quizToken, talkToken].sort() });
  });

  test("an unknown group answers 404", async () => {
    const { cookie } = await createTestScannerSession();

    const { json, status } = await tokensAsScanner(
      "/admin/groups/999999/scan-tokens",
      cookie,
    );
    expect(status).toBe(404);
    expect(json).toEqual({ status: "not_found" });
  });

  test("an editor login is refused before the door is looked up", async () => {
    const listing = await createTestListing({ name: "Staff door" });
    const { cookie } = await createTestEditorSession();

    const { status } = await tokensAsScanner(
      `/admin/listing/${listing.id}/scan-tokens`,
      cookie,
    );
    expect(status).toBe(403);
  });
});
