/**
 * Offline mode at a scanner door: the paged download of the door's offline
 * ticket list. The first page writes the activity log entry, and each later
 * page needs the signed cursor that the page before it issued.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { expectPrivateJson } from "#test/blackbox/headers.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";

/** The people one page of the list reads. */
const PAGE_PEOPLE = 250;

/** The words of one download's log entry. */
const DOWNLOADED = "Offline ticket list download started for";

const loggedIn = async (): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  return app;
};

/** One page of a door's list, read as the scanner page reads it: the first
 * page with no `from`, and each later page with the cursor it was given. */
const cachePage = async (
  app: App,
  door: string,
  from?: string,
): Promise<{ status: number; body: unknown }> => {
  const query = from === undefined ? "" : `?from=${encodeURIComponent(from)}`;
  const page = await app.get(`${door}/scan-cache${query}`);
  return { body: JSON.parse(page.html), status: page.status };
};

/** The cursor that a page names for the page after it. */
const nextOf = (page: { body: unknown }): string => {
  const { next } = page.body as { next: unknown };
  if (typeof next !== "string") throw new Error("The page names no cursor.");
  return next;
};

/** How many download entries the activity log holds. */
const downloadsLogged = async (app: App): Promise<number> =>
  (await app.get("/admin/log")).html.split(DOWNLOADED).length - 1;

/** A door of 251 people: one full page, then a page of one. */
const twoPageDoor = async (): Promise<string> => {
  const listing = await createTestListing({ maxAttendees: 1000 });
  await seedFillerAttendees(listing.id, PAGE_PEOPLE + 1);
  return `/admin/listing/${listing.id}`;
};

const REFUSED = { body: { error: "Invalid page cursor" }, status: 400 };

describeWithEnv("offline mode at a scanner door", { db: true }, () => {
  test("reads a big door's list in pages of people, and logs it once", async () => {
    const app = await loggedIn();
    const door = await twoPageDoor();

    const first = await cachePage(app, door);
    // Every filler ticket carries the same token, so each page holds one
    // entry for the whole booking.
    expect(first).toEqual({
      body: {
        entries: [
          {
            details: [],
            hash: expect.any(String),
            name: "Filler",
            quantity: 1,
          },
        ],
        next: expect.stringMatching(/^sc1\./),
        people: PAGE_PEOPLE,
        total: PAGE_PEOPLE + 1,
      },
      status: 200,
    });
    const { entries } = first.body as { entries: unknown[] };

    // The cursor names the last person read, so the next page reads the
    // one person left: no one skipped and no one read twice.
    expect((await cachePage(app, door, nextOf(first))).body).toEqual({
      entries,
      next: null,
      people: 1,
      total: PAGE_PEOPLE + 1,
    });
    // The later page writes no entry of its own. A new download does.
    expect(await downloadsLogged(app)).toBe(1);
    // The new download's cursor carries its own expiry, so only its shape
    // matches the first one.
    expect((await cachePage(app, door)).body).toEqual({
      ...(first.body as object),
      next: expect.stringMatching(/^sc1\./),
    });
    expect(await downloadsLogged(app)).toBe(2);
  });

  test("reads one snapshot: a booking made mid-download stays out", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ maxAttendees: 1000 });
    await seedFillerAttendees(listing.id, PAGE_PEOPLE + 1);
    const door = `/admin/listing/${listing.id}`;

    const first = await cachePage(app, door);

    // A booking made after the first page must not join the pages its
    // cursor names, even though its attendee id sorts above everyone read.
    await createTestAttendeeDirect(
      listing.id,
      "Late Comer",
      "late@example.com",
    );

    const { entries } = first.body as { entries: unknown[] };
    expect((await cachePage(app, door, nextOf(first))).body).toEqual({
      // Every filler shares one booking, so both pages hold the same one
      // entry — and the late booking holds none.
      entries,
      next: null,
      people: 1,
      total: PAGE_PEOPLE + 1,
    });
  });

  test("answers no next page when the people fill one page exactly", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ maxAttendees: 1000 });
    await seedFillerAttendees(listing.id, PAGE_PEOPLE);
    expect((await cachePage(app, `/admin/listing/${listing.id}`)).body).toEqual(
      {
        entries: [
          {
            details: [],
            hash: expect.any(String),
            name: "Filler",
            quantity: 1,
          },
        ],
        next: null,
        people: PAGE_PEOPLE,
        total: PAGE_PEOPLE,
      },
    );
  });

  test("serves the list as private JSON under the site's policy", async () => {
    const app = await loggedIn();
    const listing = await createTestListing();
    const { headers } = await app.get(
      `/admin/listing/${listing.id}/scan-cache`,
    );
    expectPrivateJson(headers);
  });

  test("keeps every line of one person on the same page", async () => {
    const app = await loggedIn();
    const group = await createTestGroup({ scanChecksInAllListings: true });
    const west = await createTestListing({
      groupId: group.id,
      maxAttendees: 1000,
    });
    const east = await createTestListing({ groupId: group.id });
    await seedFillerAttendees(west.id, PAGE_PEOPLE);
    // The two-listing person lands on the last slot of the full first
    // page, so a page split on booking lines would cut them in two.
    await createMultiBookingAttendee("Ada Reed", "ada@example.com", [
      { listingId: west.id, quantity: 2 },
      { listingId: east.id, quantity: 1 },
    ]);
    const door = `/admin/groups/${group.id}`;

    const first = await cachePage(app, door);
    expect(first.body).toMatchObject({
      people: PAGE_PEOPLE,
      total: PAGE_PEOPLE + 1,
    });
    const second = await cachePage(app, door, nextOf(first));
    expect(second.body).toMatchObject({ next: null, people: 1 });

    // The person's whole booking answers once: one entry on one page, and
    // its quantity names every line the door checks in for them.
    const { entries } = second.body as {
      entries: { details: string[]; name: string; quantity: number }[];
    };
    const ada = entries.find((entry) => entry.name === "Ada Reed");
    expect(ada).toMatchObject({
      details: expect.arrayContaining([west.name, east.name]),
      quantity: 3,
    });
    const entryNames = (page: { body: unknown }): string[] => {
      const { entries: named } = page.body as {
        entries: { name: string }[];
      };
      return named.map((entry) => entry.name);
    };
    const names = [...entryNames(first), ...entryNames(second)];
    expect(names.filter((name) => name === "Ada Reed")).toHaveLength(1);
  });

  test("answers an empty last page for a door with no people", async () => {
    const app = await loggedIn();
    const group = await createTestGroup();
    const listing = await createTestListing();
    const empty = { entries: [], next: null, people: 0, total: 0 };
    // A group with no listings, and a listing nobody booked.
    expect((await cachePage(app, `/admin/groups/${group.id}`)).body).toEqual(
      empty,
    );
    expect((await cachePage(app, `/admin/listing/${listing.id}`)).body).toEqual(
      empty,
    );
  });

  test("refuses a cursor that the page before did not issue", async () => {
    const app = await loggedIn();
    const door = await twoPageDoor();
    const cursor = nextOf(await cachePage(app, door));
    const [prefix = "", payload = "", sig = ""] = cursor.split(".");
    // A cursor that names another attendee keeps the old signature.
    const forged = `${prefix}.${payload.slice(0, -2)}AA.${sig}`;
    for (const from of ["", "0", "abc", "sc1.x.y", forged]) {
      expect(await cachePage(app, door, from), from).toEqual(REFUSED);
    }
    expect(await downloadsLogged(app)).toBe(1);
  });

  test("refuses a cursor on another door or for another person", async () => {
    const app = await loggedIn();
    const door = await twoPageDoor();
    const other = await createTestListing();
    const cursor = nextOf(await cachePage(app, door));
    expect(await cachePage(app, `/admin/listing/${other.id}`, cursor)).toEqual(
      REFUSED,
    );

    // Another person who skips the logged first page cannot use it.
    const scanner = createApp(
      inProcess,
      (await createTestScannerSession()).cookie,
    );
    expect(await cachePage(scanner, door, cursor)).toEqual(REFUSED);
    expect(await downloadsLogged(app)).toBe(1);
  });

  test("accepts a cursor for the hour after its page, and not after", async () => {
    const app = await loggedIn();
    const door = await twoPageDoor();
    const cursor = nextOf(await cachePage(app, door));
    {
      using _time = new FakeTime(Date.now() + 59 * 60 * 1000);
      expect(await cachePage(app, door, cursor)).toEqual({
        body: expect.objectContaining({ next: null, people: 1 }),
        status: 200,
      });
    }
    using _time = new FakeTime(Date.now() + 61 * 60 * 1000);
    expect(await cachePage(app, door, cursor)).toEqual(REFUSED);
  });

  test("logs who downloaded the list at each kind of door", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ name: "Summer Gala" });
    const group = await createTestGroup({ name: "Winter Barn" });
    await cachePage(app, `/admin/listing/${listing.id}`);
    await cachePage(app, `/admin/groups/${group.id}`);
    // The listing door's entry links its listing. The group door's does not.
    expectIncludesAll((await app.get("/admin/log")).html, [
      `<td>${DOWNLOADED} 'Summer Gala' by 'jo'</td><td></td><td><a href="/admin/listing/${listing.id}">`,
      `<td>${DOWNLOADED} 'Winter Barn' by 'jo'</td><td></td><td></td>`,
    ]);
  });

  test("logs nothing for a No check-in listing", async () => {
    const app = await loggedIn();
    const closed = await createTestListing({ purchaseOnly: true });
    const page = await app.get(`/admin/listing/${closed.id}/scan-cache`);
    expect(page.status).toBe(404);
    expect(await downloadsLogged(app)).toBe(0);
  });
});
