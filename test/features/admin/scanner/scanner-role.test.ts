/** The scanner class's whole surface, the direct suite beside the routes it
 * exercises in src/features/admin/scanner.ts: the doors list a scanner login
 * lands on, the two door pages, the door scan API, and every refusal around
 * them.
 *
 * The scan rule itself has exact tests in test/features/admin/scan-decision
 * and the door suites beside this one; this one owns who may open a door.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { addDays, formatDateLabel } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookTestAttendee,
  createMultiBookingAttendee,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { storedCheckinRows } from "#test-utils/db-helpers/checkin-rows.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { allDays, createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  requestAsSession,
  testCsrfToken,
} from "#test-utils/session.ts";
import { doorPage, groupDoor } from "./support.ts";

/** A live door scan sent as a scanner session, the page's own script's shape. */
const scanAsScanner = async (
  path: string,
  cookie: string,
  token: string,
): Promise<Response> =>
  await handleRequest(
    requestAsSession(
      path,
      { cookie, csrfToken: await testCsrfToken() },
      {
        body: JSON.stringify({ token }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    ),
  );

/** The scanner page GET one session would send. */
const getAs = async (path: string, cookie: string): Promise<Response> => {
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  return await awaitTestRequest(path, { cookie });
};

/** Ask one admin page as one restricted session and return the status. */
const statusAs = async (path: string, cookie: string): Promise<number> =>
  (
    await handleRequest(
      requestAsSession(path, { cookie, csrfToken: "not-needed-past-the-gate" }),
    )
  ).status;

describeWithEnv("the scanner class's doors", { db: true }, () => {
  test("tells a scanner there are no doors yet on an empty site", async () => {
    const { cookie } = await createTestScannerSession();

    const response = await getAs("/admin/scanner", cookie);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(t("admin.scanner.doors_empty"));
  });

  test("lists every listing door and group door on the doors page", async () => {
    const { cookie } = await createTestScannerSession();
    await createTestListing({ maxAttendees: 10, name: "Ceilidh" });
    await createTestListing({
      maxAttendees: 10,
      name: "Merch Stand",
      purchaseOnly: true,
    });
    await createTestGroup({ name: "Summer Ball" });

    const response = await getAs("/admin/scanner", cookie);
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).toContain("Ceilidh");
    expect(body).toContain("Summer Ball");
    // A "No check-in" listing sells something with no door, so it is not one.
    expect(body).not.toContain("Merch Stand");
  });

  test("orders the doors by name", async () => {
    const { cookie } = await createTestScannerSession();
    await createTestListing({ maxAttendees: 10, name: "Zumba" });
    await createTestListing({ maxAttendees: 10, name: "Archery" });
    await createTestGroup({ name: "Winter Social" });
    await createTestGroup({ name: "Autumn Fair" });

    const body = await (await getAs("/admin/scanner", cookie)).text();
    expect(body.indexOf("Archery")).toBeLessThan(body.indexOf("Zumba"));
    expect(body.indexOf("Autumn Fair")).toBeLessThan(
      body.indexOf("Winter Social"),
    );
  });

  test("opens the listing scanner page for a scanner login", async () => {
    const listing = await createTestListing({ maxAttendees: 10, name: "Quiz" });
    const attendee = await bookTestAttendee(
      [listing.id],
      "Roster Person",
      "roster@example.com",
    );
    const { cookie } = await createTestScannerSession();

    const response = await getAs(
      `/admin/listing/${listing.id}/scanner`,
      cookie,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Quiz");
    // The guide link behind this page is staff-only, so a scanner login must
    // not be promised it (never render a forbidden link).
    expect(body).not.toContain('href="/admin/guide');
    // The manual pick list carries attendee ids, never the ticket
    // credential: the token opens the attendee's own ticket page elsewhere.
    expect(body).not.toContain(attendee.ticket_token);
  });

  test("answers 404 for a no-check-in listing's door and refuses its scan", async () => {
    const { attendee, listing, token } = await createTestAttendeeWithToken(
      "Ida",
      "ida@example.com",
      { name: "Merch Stand", purchaseOnly: true },
    );
    const scanner = await createTestScannerSession();

    const page = await getAs(
      `/admin/listing/${listing.id}/scanner`,
      scanner.cookie,
    );
    expect(page.status).toBe(404);
    // The door's scan API refuses the same listing: the app's ticket-QR path
    // never marks a no-check-in row as attended, and neither does the door.
    const scan = await scanAsScanner(
      `/admin/listing/${listing.id}/scan`,
      scanner.cookie,
      token,
    );
    expect((await scan.json()).status).toBe("wrong_listing");
    // The booking row is still there, and still unchecked.
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
  });

  test("opens the group scanner page for a scanner login", async () => {
    const { group } = await groupDoor(1);
    const { cookie } = await createTestScannerSession();

    const response = await getAs(`/admin/groups/${group.id}/scanner`, cookie);
    expect(response.status).toBe(200);
  });

  test("checks a ticket in through the listing door as a scanner", async () => {
    const { attendee, listing, token } = await createTestAttendeeWithToken(
      "Ann",
      "ann@example.com",
      { name: "Doors" },
    );
    const { cookie } = await createTestScannerSession();

    const response = await scanAsScanner(
      `/admin/listing/${listing.id}/scan`,
      cookie,
      token,
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { status: string; name: string };
    expect(json.status).toBe("checked_in");
    expect(json.name).toBe("Ann");

    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 1 }]);
  });

  test("checks a member ticket in through the group door as a scanner", async () => {
    const { group, members } = await groupDoor(1);
    const { ticket_token } = await createMultiBookingAttendee(
      "Pat",
      "pat@example.com",
      [{ listingId: members[0]!.id, quantity: 1 }],
    );
    const { cookie } = await createTestScannerSession();

    const response = await scanAsScanner(
      `/admin/groups/${group.id}/scan`,
      cookie,
      ticket_token,
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { status: string };
    expect(json.status).toBe("checked_in");
  });

  test("names the same-named picks apart by their day and listing on a group door", async () => {
    const { group, members } = await groupDoor(
      2,
      {
        bookableDays: allDays,
        listingType: "daily",
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      },
      ["Standard", "Society"],
    );
    const firstDay = addDays(todayInTz(settings.timezone), 10);
    // Two people with the same name and the same number of places, booked
    // for different days on different listings of this door. The day, and
    // the listing on a multi-listing door, are what tell their two picks
    // apart on the roster.
    await bookTestAttendee(
      [{ date: firstDay, listingId: members[0]!.id, quantity: 2 }],
      "Ada",
      "ada-standard@test.com",
    );
    await bookTestAttendee(
      [{ date: addDays(firstDay, 1), listingId: members[1]!.id, quantity: 2 }],
      "Ada",
      "ada-society@test.com",
    );

    const body = await doorPage(group.id);
    expect(body).toContain(
      `Ada (2 tickets) — Standard · ${formatDateLabel(firstDay)}`,
    );
    expect(body).toContain(
      `Ada (2 tickets) — Society · ${formatDateLabel(addDays(firstDay, 1))}`,
    );
  });

  test("an editor and an agent are refused every door and every scan", async () => {
    const { attendee, listing, token } = await createTestAttendeeWithToken(
      "Turned Away",
      "turnedaway@example.com",
      { name: "Gate" },
    );
    const group = await createTestGroup({ name: "Private Party" });
    const editor = await createTestEditorSession();
    const agent = await createTestAgentSession();

    const doorPaths = [
      "/admin/scanner",
      `/admin/listing/${listing.id}/scanner`,
      `/admin/groups/${group.id}/scanner`,
    ];
    for (const { cookie } of [editor, agent]) {
      for (const path of doorPaths) {
        expect(await statusAs(path, cookie), `${path}`).toBe(403);
      }
    }

    // The scan gate must refuse before the write: the ticket stays outside.
    for (const { cookie } of [editor, agent]) {
      const response = await scanAsScanner(
        `/admin/listing/${listing.id}/scan`,
        cookie,
        token,
      );
      expect(response.status).toBe(403);
    }
    expect(await storedCheckinRows(attendee.id)).toEqual([{ checked_in: 0 }]);
  });
});
