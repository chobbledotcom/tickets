/** A scanner login and part bookings: the door-only role must reach every
 * count the doors can make, and nothing the staff roster owns. The scan
 * asks how many tickets, the ticket page reads the part count, and the
 * staff quantity page stays shut. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { moveTickets } from "#db/attendees/update.ts";
import { handleRequest } from "#routes";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import { requestAsSession, testCsrfToken } from "#test-utils/session.ts";

/** One door scan sent as a scanner session, with the page script's body. */
const scanAsScanner = async (
  path: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  (await (
    await handleRequest(
      requestAsSession(
        path,
        { cookie, csrfToken: await testCsrfToken() },
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    )
  ).json()) as Record<string, unknown>;

/** A party of three on one listing, and a scanner login. */
const partyOfThree = async () => {
  const booked = await createTestAttendeeWithToken(
    "Pia",
    "pia@example.com",
    { name: "Doors" },
    3,
  );
  const { cookie } = await createTestScannerSession();
  return { ...booked, cookie };
};

describeWithEnv("a scanner login and part bookings", { db: true }, () => {
  test("a scan asks how many tickets, then admits the scanner's pick", async () => {
    const { attendee, cookie, listing, token } = await partyOfThree();
    const scanPath = `/admin/listing/${listing.id}/scan`;

    expect(await scanAsScanner(scanPath, cookie, { token })).toEqual({
      listingName: "Doors",
      max: 3,
      name: "Pia",
      status: "select_quantity",
    });
    expect(
      await scanAsScanner(scanPath, cookie, { quantity: 2, token }),
    ).toEqual({
      listingName: "Doors",
      name: "Pia",
      quantity: 2,
      remaining: 1,
      status: "checked_in",
      total: 3,
    });

    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 2 }]);
    expect(await activityMessages()).toContain(
      "Attendee checked in 2 tickets via scanner for 'Doors'",
    );
  });

  test("the ticket page shows a scanner the part count and both door actions", async () => {
    const { attendee, cookie, listing, token } = await partyOfThree();
    await moveTickets("admit", [
      { attendeeId: attendee.id, count: 1, listingId: listing.id },
    ]);

    const body = await (
      await awaitTestRequest(`/checkin/${token}`, { cookie })
    ).text();

    expect(body).toContain("Checked in (1 of 3)");
    expect(body).toContain("Check In All");
    expect(body).toContain("Check Out All");
    // The per-line quantity page is a staff page, so the door-only view
    // never links to it (never render a forbidden link).
    expect(body).not.toContain(
      `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
    );
  });

  test("the staff quantity page and its POST stay shut to a scanner", async () => {
    const { attendee, cookie, listing } = await partyOfThree();
    const path = `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`;

    const page = await handleRequest(
      requestAsSession(path, { cookie, csrfToken: await testCsrfToken() }),
    );
    expect(page.status).toBe(403);

    const post = await handleRequest(
      requestAsSession(
        path,
        { cookie, csrfToken: await testCsrfToken() },
        {
          body: new URLSearchParams({
            check_in: "true",
            csrf_token: await testCsrfToken(),
            quantity: "3",
          }),
          method: "POST",
        },
      ),
    );
    expect(post.status).toBe(403);
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
  });

  test("the scanner's pick list shows the tickets a part party still owes", async () => {
    const { attendee, cookie, listing } = await partyOfThree();
    await moveTickets("admit", [
      { attendeeId: attendee.id, count: 2, listingId: listing.id },
    ]);

    const body = await (
      await awaitTestRequest(`/admin/listing/${listing.id}/scanner`, {
        cookie,
      })
    ).text();

    expect(body).toContain(`data-attendee-id="${attendee.id}"`);
    expect(body).toContain('data-quantity="1"');
    expect(body).toContain("Pia (1 ticket)");
  });
});
