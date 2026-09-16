/** Tests for the group scanner's scan API, the direct suite beside the
 * routes it exercises in src/features/admin/scanner.ts:
 * POST /admin/groups/:id/scan - the same JSON check-in API over the group's
 * members
 *
 * The scan rule itself has exact tests in test/features/admin/scan-decision;
 * this suite proves the route: the scope from the group's membership, the
 * walk, the stored checkbox, and the guards.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import {
  adminFormPost,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import {
  editorScan,
  groupDoor,
  scanAtDoor,
  ticketFromItsOwnGroup,
} from "./support.ts";

describeWithEnv("group scanner scans", { db: true }, () => {
  test("checks a member ticket in through the group door", async () => {
    const { group, members } = await groupDoor();
    const ticket = await createMultiBookingAttendee("Ann", "ann@example.com", [
      { listingId: members[0]!.id, quantity: 2 },
    ]);

    const { json } = await scanAtDoor(group.id, {
      token: ticket.ticket_token,
    });

    expect(json.status).toBe("checked_in");
    expect(json.name).toBe("Ann");
    expect(json.listingName).toBe("Standard");
    expect(json.quantity).toBe(2);
    expect(json.remaining).toBe(0);
  });

  test("walks a several-listing ticket one listing per scan", async () => {
    const { group, members } = await groupDoor(2);
    const ticket = await createMultiBookingAttendee("Pat", "pat@example.com", [
      { listingId: members[0]!.id, quantity: 2 },
      { listingId: members[1]!.id, quantity: 1 },
    ]);
    const token = ticket.ticket_token;

    const first = await scanAtDoor(group.id, { token });
    expect(first.json.status).toBe("checked_in");
    expect(first.json.listingName).toBe("Standard");
    expect(first.json.remaining).toBe(1);

    const second = await scanAtDoor(group.id, { token });
    expect(second.json.status).toBe("checked_in");
    expect(second.json.listingName).toBe("Society");
    expect(second.json.remaining).toBe(0);

    const third = await scanAtDoor(group.id, { token });
    expect(third.json.status).toBe("already_checked_in");
    expect(third.json.listingName).toBe("Standard, Society");
    expect(third.json.quantity).toBe(3);
  });

  test("an outside-group ticket is queried, and force lets it in", async () => {
    const { group, members } = await groupDoor(2);
    const outside = await createTestAttendeeWithToken("Zoe", "zoe@example.com");

    const rejected = await scanAtDoor(group.id, { token: outside.token });
    expect(rejected.json.status).toBe("wrong_listing");
    expect(rejected.json.listingName).toBe(outside.listing.name);

    const forced = await scanAtDoor(group.id, {
      force: true,
      token: outside.token,
    });
    expect(forced.json.status).toBe("checked_in");
    expect(forced.json.listingName).toBe(outside.listing.name);

    const listingDoor = await handleRequest(
      requestAsSession(
        `/admin/listing/${members[0]!.id}/scan`,
        { cookie: await testCookie(), csrfToken: await testCsrfToken() },
        {
          body: JSON.stringify({ token: outside.token }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    expect((await listingDoor.json()).status).toBe("wrong_listing");
  });

  test("a multi-listing ticket from outside names every listing it holds", async () => {
    const door = await groupDoor();
    const token = await ticketFromItsOwnGroup("Zia", "Elsewhere");

    const rejected = await scanAtDoor(door.group.id, { token });

    expect(rejected.json.status).toBe("wrong_listing");
    expect(rejected.json.listingName).toBe("Quiz, Talk");
    expect(rejected.json.name).toBe("Zia");
  });

  test("the checkbox never widens a forced override onto every listing", async () => {
    // Forced overrides are an organiser's single judgement at one door, so
    // they stay on the one-listing walk rule even when the group's own box
    // says "check in every listing".
    const door = await groupDoor();
    const token = await ticketFromItsOwnGroup("Ora", "Elsewhere two");
    await adminFormPost(`/admin/groups/${door.group.id}/scanner`, {
      csrf_token: await testCsrfToken(),
      scan_checks_in_all_listings: "1",
    });

    const forced = await scanAtDoor(door.group.id, {
      force: true,
      token,
    });

    expect(forced.json.status).toBe("checked_in");
    expect(forced.json.listingName).toBe("Quiz");
    expect(forced.json.remaining).toBe(1);
  });

  test("a failed activity row rolls the whole admission back", async () => {
    const { group, members } = await groupDoor();
    const ticket = await createMultiBookingAttendee("Ash", "ash@example.com", [
      { listingId: members[0]!.id, quantity: 1 },
    ]);

    // The scan's own error logging rethrows in tests, so the failed write is
    // the rejection itself.
    const scan = withDbFault(
      `CREATE TRIGGER test_no_activity_log
        BEFORE INSERT ON activity_log
      BEGIN
        SELECT RAISE(ABORT, 'activity log unavailable');
      END`,
      "test_no_activity_log",
      () => scanAtDoor(group.id, { token: ticket.ticket_token }),
    );
    await expect(scan).rejects.toThrow("activity log unavailable");

    // The check-in the admission wrote must not survive the failed activity
    // record: the transaction rolled both back.
    const { queryOne } = await import("#db/client.ts");
    const row = await queryOne<{ checked_in: number }>(
      "SELECT checked_in FROM listing_attendees WHERE attendee_id = ?",
      [ticket.id],
    );
    expect(row?.checked_in).toBe(0);
  });

  test("two concurrent group scans of one ticket leave one true state", async () => {
    const { group, members } = await groupDoor(2);
    const ticket = await createMultiBookingAttendee("Ivy", "ivy@example.com", [
      { listingId: members[0]!.id, quantity: 1 },
      { listingId: members[1]!.id, quantity: 1 },
    ]);
    await adminFormPost(`/admin/groups/${group.id}/scanner`, {
      csrf_token: await testCsrfToken(),
      scan_checks_in_all_listings: "1",
    });

    const [first, second] = await Promise.all([
      scanAtDoor(group.id, { token: ticket.ticket_token }),
      scanAtDoor(group.id, { token: ticket.ticket_token }),
    ]);

    // Both answer a true state: a check-in or the already-in answer of the
    // other scan's write. Neither is refused or admitted twice.
    for (const answer of [first, second]) {
      expect(["checked_in", "already_checked_in"]).toContain(
        answer.json.status,
      );
      expect(answer.json.name).toBe("Ivy");
    }
    const after = await scanAtDoor(group.id, {
      token: ticket.ticket_token,
    });
    expect(after.json.status).toBe("already_checked_in");
    expect(after.json.listingName).toBe("Standard, Society");
  });

  test("a listing door never widens a forced scan into other listings", async () => {
    const { group, members } = await groupDoor(2);
    const holder = await createMultiBookingAttendee("Fay", "fay@example.com", [
      { listingId: members[0]!.id, quantity: 1 },
      { listingId: members[1]!.id, quantity: 1 },
    ]);

    // The person holds no row on the unrelated listing, so force widens the
    // door to their ticket — and still admits only one listing.
    const unrelated = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Unrelated door",
    });
    const forcedAtListing = await handleRequest(
      requestAsSession(
        `/admin/listing/${unrelated.id}/scan`,
        { cookie: await testCookie(), csrfToken: await testCsrfToken() },
        {
          body: JSON.stringify({
            force: true,
            token: holder.ticket_token,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    // Even under force a listing door admits exactly one listing.
    expect((await forcedAtListing.json()).status).toBe("checked_in");
    expect((await forcedAtListing.json()).listingName).toBe("Standard");
    expect((await forcedAtListing.json()).remaining).toBe(1);
  });

  test("a No check-in member never enters the door", async () => {
    const group = await createTestGroup({ name: "Mixed" });
    const entry = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Entry",
    });
    const merch = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Merch",
      purchaseOnly: true,
    });

    const buyer = await createMultiBookingAttendee("Ivy", "ivy@example.com", [
      { listingId: entry.id, quantity: 1 },
      { listingId: merch.id, quantity: 1 },
    ]);

    const first = await scanAtDoor(group.id, { token: buyer.ticket_token });
    expect(first.json.status).toBe("checked_in");
    expect(first.json.listingName).toBe("Entry");

    const second = await scanAtDoor(group.id, { token: buyer.ticket_token });
    expect(second.json.status).toBe("already_checked_in");

    const merchOnly = await createMultiBookingAttendee(
      "Ola",
      "ola@example.com",
      [{ listingId: merch.id, quantity: 1 }],
    );
    const refused = await scanAtDoor(group.id, {
      token: merchOnly.ticket_token,
    });
    expect(refused.json.status).toBe("wrong_listing");
    expect(refused.json.listingName).toBe("Merch");
  });

  test("a hidden member stays part of the door", async () => {
    const group = await createTestGroup({ name: "Guest list" });
    const member = await createTestListing({
      groupId: group.id,
      hidden: true,
      maxAttendees: 10,
      name: "Backstage",
    });
    const guest = await createMultiBookingAttendee("Kim", "kim@example.com", [
      { listingId: member.id, quantity: 1 },
    ]);

    const { json } = await scanAtDoor(group.id, {
      token: guest.ticket_token,
    });
    expect(json.status).toBe("checked_in");
    expect(json.listingName).toBe("Backstage");
  });

  test("admits a part-refunded ticket on its live listing only", async () => {
    const { group, members } = await groupDoor(2);
    const ticket = await createMultiBookingAttendee("Nic", "nic@example.com", [
      { listingId: members[0]!.id, quantity: 1 },
      { listingId: members[1]!.id, quantity: 1 },
    ]);
    await postAttendeeRefund({
      attendeeId: ticket.id,
      listingId: members[1]!.id,
    });

    const first = await scanAtDoor(group.id, { token: ticket.ticket_token });
    expect(first.json.status).toBe("checked_in");
    expect(first.json.listingName).toBe("Standard");

    const second = await scanAtDoor(group.id, { token: ticket.ticket_token });
    expect(second.json.status).toBe("already_checked_in");
  });

  test("answers refunded when every member row was refunded", async () => {
    const { group, members } = await groupDoor();
    const ticket = await createMultiBookingAttendee("Ray", "ray@example.com", [
      { listingId: members[0]!.id, quantity: 1 },
    ]);
    await postAttendeeRefund({
      attendeeId: ticket.id,
      listingId: members[0]!.id,
    });

    const { json } = await scanAtDoor(group.id, {
      token: ticket.ticket_token,
    });
    expect(json.status).toBe("refunded");
    expect(json.name).toBe("Ray");
  });

  test("holds a non-transferable member until the ID is confirmed", async () => {
    const group = await createTestGroup({ name: "Named" });
    const member = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Named entry",
      nonTransferable: true,
    });
    const ticket = await createMultiBookingAttendee("Lee", "lee@example.com", [
      { listingId: member.id, quantity: 1 },
    ]);

    const held = await scanAtDoor(group.id, { token: ticket.ticket_token });
    expect(held.json.status).toBe("verify_id");

    const admitted = await scanAtDoor(group.id, {
      id_verified: true,
      token: ticket.ticket_token,
    });
    expect(admitted.json.status).toBe("checked_in");
  });

  test("refuses an editor outright and guards the missing group", async () => {
    const editorResponse = await editorScan(123, { token: "any" });
    expect(editorResponse.status).toBe(403);

    const missing = await scanAtDoor(99999, { token: "any" });
    expect(missing.response.status).toBe(404);
    expect(missing.json.status).toBe("not_found");
  });

  test("answers 401, 403, and 400 like the listing scan", async () => {
    const { group } = await groupDoor(1);

    const unauth = await handleRequest(
      new Request(`http://localhost/admin/groups/${group.id}/scan`, {
        body: JSON.stringify({ token: "x" }),
        headers: { "content-type": "application/json", host: "localhost" },
        method: "POST",
      }),
    );
    expect(unauth.status).toBe(401);

    const badCsrf = await handleRequest(
      requestAsSession(
        `/admin/groups/${group.id}/scan`,
        { cookie: await testCookie(), csrfToken: "bad-token" },
        {
          body: JSON.stringify({ token: "x" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    expect(badCsrf.status).toBe(403);

    const missing = await scanAtDoor(group.id, {});
    expect(missing.response.status).toBe(400);
    expect(missing.json.error).toBe("Missing token");
  });
});
