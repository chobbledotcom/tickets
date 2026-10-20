/** The scanner's offline ticket list: the door's own tickets for the scanner
 * page to save on load, answered only as SHA-256 digests. A door role reads
 * its scope's list, a staff-only role is refused before the door is looked
 * up, and a "No check-in" listing hands out nothing. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { sha256Hex } from "#crypto/sha256.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendee,
  createTestAttendeeDirect,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { refundThroughLedger } from "#test-utils/ledger.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  createTestEditorSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";
import {
  groupDoor,
  refundedOrderWithALiveOrder,
  scanAtDoor,
} from "./support.ts";

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

/** The saved list a scanner session reads for a group door. Unasserted:
 * each test names the hashes it expects. */
const savedGroupHashes = async (
  groupId: number,
): Promise<Record<string, unknown>> => {
  const { cookie } = await createTestScannerSession();
  const { json } = await tokensAsScanner(
    `/admin/groups/${groupId}/scan-tokens`,
    cookie,
  );
  return json;
};

describeWithEnv("the scanner's offline ticket list", { db: true }, () => {
  test("a listing door's list answers its tickets only as digests", async () => {
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
    const digests = await Promise.all(
      [first.token, second.token].map(sha256Hex),
    );
    expect(json).toEqual({ hashes: digests.sort() });
    // The credential itself never leaves the server.
    expect(JSON.stringify(json)).not.toContain(first.token);
    expect(JSON.stringify(json)).not.toContain(second.token);
  });

  test("a listing with no tickets answers an empty list", async () => {
    const listing = await createTestListing({ name: "Empty door" });
    const { cookie } = await createTestScannerSession();

    const { json, status } = await tokensAsScanner(
      `/admin/listing/${listing.id}/scan-tokens`,
      cookie,
    );
    expect(status).toBe(200);
    expect(json).toEqual({ hashes: [] });
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
    const digests = await Promise.all([quizToken, talkToken].map(sha256Hex));
    expect(json).toEqual({ hashes: digests.sort() });
    // No member token of any kind travels, the shop's included.
    expect(JSON.stringify(json)).not.toContain(shopToken);
  });

  test("a ticket whose money was given back is not saved", async () => {
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Ada",
      "ada@example.com",
    );
    await refundThroughLedger(attendee.id, door.members[0]!.id);
    const json = await savedGroupHashes(door.group.id);
    // The door's own scan turns a refunded ticket away, so the saved list
    // must never tell the door the ticket looks legitimate.
    expect(json).toEqual({ hashes: [] });
  });

  test("a line with no tickets behind it is not saved", async () => {
    const door = await groupDoor(1);
    await createTestAttendeeDirect(
      door.members[0]!.id,
      "Ghost",
      "ghost@example.com",
      0,
    );
    const json = await savedGroupHashes(door.group.id);
    expect(json).toEqual({ hashes: [] });
  });

  test("a ticket with a refunded order and a live order is saved once", async () => {
    const { door, attendee } = await refundedOrderWithALiveOrder(
      "Merged",
      "merged@example.com",
    );
    const json = await savedGroupHashes(door.group.id);
    // The live order still gets in, so its one digest travels.
    expect(json).toEqual({ hashes: [await sha256Hex(attendee.ticket_token)] });
  });

  test("a ticket the door already used stays in the list", async () => {
    // A used ticket answers "already checked in", not a refusal — and the
    // per-delivery answers a replayed check-in fetches home rest on that.
    const door = await groupDoor(1);
    const attendee = await bookTestAttendee(
      [door.members[0]!.id],
      "Bruno",
      "bruno@example.com",
    );
    const used = await scanAtDoor(door.group.id, {
      token: attendee.ticket_token,
    });
    expect(used.json.status).toBe("checked_in");
    const json = await savedGroupHashes(door.group.id);
    expect(json).toEqual({ hashes: [await sha256Hex(attendee.ticket_token)] });
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
