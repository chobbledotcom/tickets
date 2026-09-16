/** Tests for the group scanner page
 * GET /admin/groups/:id/scanner - one door for every member of a group
 * POST /admin/groups/:id/scanner - the "check in every listing" box
 *
 * The scan API itself has its own suite beside this one; this one owns the
 * page: the scope from the group's membership, the roster, the stored
 * checkbox, and the guards.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import {
  adminFormPost,
  createTestEditorSession,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";
import { doorPage, groupDoor, scanAtDoor } from "./support.ts";

describeWithEnv("group scanner page", { db: true }, () => {
  test("renders one door for the whole group", async () => {
    const { group, members } = await groupDoor();
    const body = await doorPage(group.id);

    expect(body).toContain(`Scanner: ${group.name}`);
    expect(body).toContain(`data-scan-path="/admin/groups/${group.id}/scan"`);
    expect(body).not.toContain(`/admin/listing/${members[0]!.id}/scan`);
  });

  test("offers one option per person, with their places summed", async () => {
    const { group, members } = await groupDoor(2);
    await createMultiBookingAttendee("Sam", "sam@example.com", [
      { listingId: members[0]!.id, quantity: 2 },
      { listingId: members[1]!.id, quantity: 1 },
    ]);

    const body = await doorPage(group.id);

    expect(body).toContain("Sam (3 attendees)");
    expect(body.match(/role="option"/g)?.length).toBe(1);
  });

  test("does not offer refunded or fully checked-in people", async () => {
    const { group, members } = await groupDoor(2);
    const refunded = await createMultiBookingAttendee(
      "Rob",
      "rob@example.com",
      [{ listingId: members[0]!.id, quantity: 1 }],
    );
    const seated = await createMultiBookingAttendee("Mel", "mel@example.com", [
      { listingId: members[1]!.id, quantity: 1 },
    ]);
    await postAttendeeRefund({
      attendeeId: refunded.id,
      listingId: members[0]!.id,
    });
    await scanAtDoor(group.id, { token: seated.ticket_token });

    const body = await doorPage(group.id);

    expect(body).not.toContain("Rob");
    expect(body).not.toContain("Mel");
  });

  test("shows the check-every-listing box once one scan can span listings", async () => {
    const door = await groupDoor(2);
    const body = await doorPage(door.group.id);
    expect(body).toContain('name="scan_checks_in_all_listings"');
    expect(body).toContain(`action="/admin/groups/${door.group.id}/scanner"`);

    const single = await groupDoor(1, {}, ["Solo"], "Solo door");
    expect(await doorPage(single.group.id)).not.toContain(
      'name="scan_checks_in_all_listings"',
    );
  });

  test("saves the box and carries the stored state back to the page", async () => {
    const { group, members } = await groupDoor(2);
    const ticket = await createMultiBookingAttendee("Van", "van@example.com", [
      { listingId: members[0]!.id, quantity: 1 },
      { listingId: members[1]!.id, quantity: 2 },
    ]);

    const save = await adminFormPost(`/admin/groups/${group.id}/scanner`, {
      csrf_token: await testCsrfToken(),
      scan_checks_in_all_listings: "1",
    });
    expect(save.response.status).toBe(302);
    expect(save.response.headers.get("location")).toContain(
      `/admin/groups/${group.id}/scanner`,
    );
    expect(await doorPage(group.id)).toContain("checked");

    const { json } = await scanAtDoor(group.id, {
      token: ticket.ticket_token,
    });
    expect(json.status).toBe("checked_in");
    expect(json.listingName).toBe("Standard, Society");
    expect(json.quantity).toBe(3);
    expect(json.remaining).toBe(0);
  });

  test("a No check-in member alone gives the door no box and no roster", async () => {
    const group = await createTestGroup({ name: "Merch only" });
    const merch = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "Merch",
      purchaseOnly: true,
    });
    await createMultiBookingAttendee("Ola", "ola@example.com", [
      { listingId: merch.id, quantity: 1 },
    ]);
    const body = await doorPage(group.id);

    expect(body).not.toContain('name="scan_checks_in_all_listings"');
    expect(body).not.toContain("Ola");
    expect(body).toContain("No tickets to check in");
  });

  test("redirects to /admin when not authenticated", async () => {
    const { group } = await groupDoor(1);
    const response = await handleRequest(
      new Request(`http://localhost/admin/groups/${group.id}/scanner`, {
        headers: { host: "localhost" },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
  });

  test("answers 404 for an unknown group", async () => {
    const response = await handleRequest(
      requestAsSession("/admin/groups/99999/scanner", {
        cookie: await testCookie(),
        csrfToken: await testCsrfToken(),
      }),
    );
    expect(response.status).toBe(404);
  });

  test("refuses an editor before the group is looked up", async () => {
    const editor = await createTestEditorSession();
    const response = await handleRequest(
      requestAsSession("/admin/groups/99999/scanner", {
        cookie: editor.cookie,
        csrfToken: await testCsrfToken(),
      }),
    );
    expect(response.status).toBe(403);
  });
});
