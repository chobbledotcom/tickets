/**
 * Offline mode at a scanner door: the logged opt-in, and the paged download
 * of the door's offline ticket list.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The people one page of the list reads. */
const PAGE_PEOPLE = 250;

const loggedIn = async (): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  return app;
};

/** One page of a door's list, read as the scanner page reads it. */
const cachePage = async (
  app: App,
  door: string,
  after?: string,
): Promise<{ status: number; body: unknown }> => {
  const query = after === undefined ? "" : `?after=${after}`;
  const page = await app.get(`${door}/scan-cache${query}`);
  return { body: JSON.parse(page.html), status: page.status };
};

/** Turn offline mode on at a door, the way its scanner page does: a JSON
 * POST that carries the CSRF token of the scanner page at `pageDoor`. */
const turnOfflineOn = async (
  app: App,
  door: string,
  pageDoor: string = door,
): Promise<Response> => {
  const scanner = await app.get(`${pageDoor}/scanner`);
  const csrf = scanner.html.match(
    /<meta name="csrf-token" content="([^"]+)"/,
  )?.[1];
  if (csrf === undefined) throw new Error("The scanner page has no token.");
  return await app.target(
    new Request(`http://localhost${door}/scan-offline`, {
      body: "{}",
      headers: {
        "content-type": "application/json",
        cookie: app.cookieHeader(),
        host: "localhost",
        "x-csrf-token": csrf,
      },
      method: "POST",
    }),
  );
};

describeWithEnv("offline mode at a scanner door", { db: true }, () => {
  test("reads a big door's list in pages of people, with the total", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ maxAttendees: 1000 });
    await seedFillerAttendees(listing.id, PAGE_PEOPLE + 1);
    const door = `/admin/listing/${listing.id}`;

    const first = await cachePage(app, door);
    expect(first.status).toBe(200);
    const { next, people, total } = first.body as {
      next: number;
      people: number;
      total: number;
    };
    expect({ people, total }).toEqual({
      people: PAGE_PEOPLE,
      total: PAGE_PEOPLE + 1,
    });

    const last = await cachePage(app, door, String(next));
    expect(last.body).toMatchObject({
      next: null,
      people: 1,
      total: PAGE_PEOPLE + 1,
    });
    expect((await cachePage(app, door, "0")).body).toEqual(first.body);
  });

  test("answers no next page when the people fill one page exactly", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ maxAttendees: 1000 });
    await seedFillerAttendees(listing.id, PAGE_PEOPLE);
    expect(
      (await cachePage(app, `/admin/listing/${listing.id}`)).body,
    ).toMatchObject({ next: null, people: PAGE_PEOPLE, total: PAGE_PEOPLE });
  });

  test("keeps every line of one person on the same page", async () => {
    const app = await loggedIn();
    const group = await createTestGroup({ scanChecksInAllListings: true });
    const west = await createTestListing({ groupId: group.id });
    const east = await createTestListing({ groupId: group.id });
    await createTestAttendeeDirect(west.id, "Ada Reed", "ada@example.com");
    await createTestAttendeeDirect(east.id, "Ben Reed", "ben@example.com");

    const page = await cachePage(app, `/admin/groups/${group.id}`);
    expect(page.body).toMatchObject({ next: null, people: 2, total: 2 });
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

  test("refuses a page cursor that is not a whole number", async () => {
    const app = await loggedIn();
    const listing = await createTestListing();
    for (const after of ["-1", "abc", "1.5"]) {
      expect(
        await cachePage(app, `/admin/listing/${listing.id}`, after),
      ).toEqual({ body: { error: "Invalid page cursor" }, status: 400 });
    }
  });

  test("logs who turned offline mode on at a listing door", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ name: "Summer Gala" });
    const answer = await turnOfflineOn(app, `/admin/listing/${listing.id}`);
    expect({ body: await answer.json(), status: answer.status }).toEqual({
      body: { status: "ok" },
      status: 200,
    });
    expect((await app.get("/admin/log")).html).toContain(
      "<td>Offline scanning turned on for 'Summer Gala' by 'jo'</td><td></td><td><a href=\"/admin/listing/",
    );
  });

  test("logs who turned offline mode on at a group door", async () => {
    const app = await loggedIn();
    const group = await createTestGroup({ name: "Winter Barn" });
    const answer = await turnOfflineOn(app, `/admin/groups/${group.id}`);
    expect(answer.status).toBe(200);
    expect((await app.get("/admin/log")).html).toContain(
      "<td>Offline scanning turned on for 'Winter Barn' by 'jo'</td><td></td><td></td>",
    );
  });

  test("refuses offline mode without the page's token", async () => {
    const app = await loggedIn();
    const listing = await createTestListing({ name: "Tokenless Gala" });
    const answer = await app.target(
      new Request(`http://localhost/admin/listing/${listing.id}/scan-offline`, {
        body: "{}",
        headers: {
          "content-type": "application/json",
          cookie: app.cookieHeader(),
          host: "localhost",
        },
        method: "POST",
      }),
    );
    expect(answer.status).toBe(403);
    expect((await app.get("/admin/log")).html).not.toContain(
      "Offline scanning turned on",
    );
  });

  test("answers 404 for offline mode at a No check-in listing", async () => {
    const app = await loggedIn();
    const open = await createTestListing();
    const closed = await createTestListing({
      name: "Shop Only",
      purchaseOnly: true,
    });
    const answer = await turnOfflineOn(
      app,
      `/admin/listing/${closed.id}`,
      `/admin/listing/${open.id}`,
    );
    expect(answer.status).toBe(404);
    expect((await app.get("/admin/log")).html).not.toContain(
      "Offline scanning turned on",
    );
  });
});
