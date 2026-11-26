/**
 * The manual check-in's search at a scanner door. The scanner page lists
 * nobody: the door finds a person by name through the search route.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  SCANNER_WORDS,
  ScannerWordsSchema,
  type WordName,
} from "#shared/scanner-words.ts";
import { type App, createApp, inProcess } from "#test/blackbox/driver.ts";
import { expectPrivateJson } from "#test/blackbox/headers.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import {
  bookTestAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { allDays, createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";

const loggedIn = async (): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  return app;
};

/** One search at a door, as the manual check-in sends it. */
const search = async (
  app: App,
  door: string,
  query: string,
): Promise<{ body: unknown; status: number }> => {
  const page = await app.get(`${door}/scan-search${query}`);
  return { body: JSON.parse(page.html), status: page.status };
};

/** One person a search finds, with no detail on a one-listing door. */
const person = (name: string, quantity = 1) => ({
  attendeeId: expect.any(Number),
  details: [],
  name,
  quantity,
});

describeWithEnv(
  "the manual check-in search at a scanner door",
  { db: true },
  () => {
    test("finds people by part of their name, ignoring case, in name order", async () => {
      const app = await loggedIn();
      const listing = await createTestListing({ maxAttendees: 10 });
      const door = `/admin/listing/${listing.id}`;
      await createTestAttendeeDirect(
        listing.id,
        "Zara Adams",
        "zara@example.com",
      );
      await createTestAttendeeDirect(listing.id, "Ada Lane", "ada@example.com");
      await createTestAttendeeDirect(listing.id, "Ben Cole", "ben@example.com");

      // The page itself names nobody.
      const page = await app.get(`${door}/scanner`);
      for (const name of ["Zara Adams", "Ada Lane", "Ben Cole"]) {
        expect(page.html).not.toContain(name);
      }

      expect(await search(app, door, "?q=%20ADA%20")).toEqual({
        body: { options: [person("Ada Lane"), person("Zara Adams")] },
        status: 200,
      });
      // Two letters is the shortest search the client sends.
      expect(await search(app, door, "?q=da")).toEqual({
        body: { options: [person("Ada Lane"), person("Zara Adams")] },
        status: 200,
      });
    });

    test("answers the door's own people who still owe tickets", async () => {
      const app = await loggedIn();
      const listing = await createTestListing({ maxAttendees: 10 });
      const other = await createTestListing({ maxAttendees: 10 });
      const door = `/admin/listing/${listing.id}`;
      const { token } = await createTestAttendeeDirect(
        listing.id,
        "Cara Vale",
        "cara@example.com",
      );
      await createTestAttendeeDirect(
        listing.id,
        "Cara Moss",
        "moss@example.com",
      );
      await createTestAttendeeDirect(
        other.id,
        "Cara Elsewhere",
        "else@example.com",
      );

      // Cara Vale is checked in, so the door owes her nothing.
      const scanner = await app.get(`${door}/scanner`);
      const csrf = scanner.html.match(
        /<meta name="csrf-token" content="([^"]+)"/,
      )?.[1];
      if (csrf === undefined) throw new Error("The scanner page has no token.");
      const checkIn = await app.target(
        new Request(`http://localhost${door}/scan`, {
          body: JSON.stringify({ token }),
          headers: {
            "content-type": "application/json",
            cookie: app.cookieHeader(),
            host: "localhost",
            "x-csrf-token": csrf,
          },
          method: "POST",
        }),
      );
      expect(checkIn.status).toBe(200);

      expect((await search(app, door, "?q=cara")).body).toEqual({
        options: [person("Cara Moss")],
      });
    });

    test("names the listing only on a door that spans several", async () => {
      const app = await loggedIn();
      const single = await createTestGroup({ name: "Single Barn" });
      const lone = await createTestListing({
        groupId: single.id,
        maxAttendees: 10,
      });
      const several = await createTestGroup({ name: "Twin Barn" });
      const west = await createTestListing({
        groupId: several.id,
        maxAttendees: 10,
      });
      await createTestListing({ groupId: several.id, maxAttendees: 10 });
      await createTestAttendeeDirect(lone.id, "Ola Lone", "ola@example.com");
      await createTestAttendeeDirect(west.id, "Ola West", "west@example.com");

      expect(
        (await search(app, `/admin/groups/${single.id}`, "?q=ola")).body,
      ).toEqual({
        options: [person("Ola Lone")],
      });
      expect(
        (await search(app, `/admin/groups/${several.id}`, "?q=ola")).body,
      ).toEqual({
        options: [{ ...person("Ola West"), details: [west.name] }],
      });
    });

    test("answers at most 20 people", async () => {
      const app = await loggedIn();
      const listing = await createTestListing({ maxAttendees: 100 });
      await seedFillerAttendees(listing.id, 21);
      const { body } = await search(
        app,
        `/admin/listing/${listing.id}`,
        "?q=fill",
      );
      expect((body as { options: unknown[] }).options).toHaveLength(20);
    });

    test("refuses a search shorter than two letters", async () => {
      const app = await loggedIn();
      const listing = await createTestListing();
      const door = `/admin/listing/${listing.id}`;
      for (const query of ["", "?q=", "?q=a", "?q=%20a%20"]) {
        expect(await search(app, door, query), query).toEqual({
          body: { error: "Search text is too short" },
          status: 400,
        });
      }
    });

    test("sends the page's words once, each with the holes it fills", async () => {
      const app = await loggedIn();
      const listing = await createTestListing();
      const page = await app.get(`/admin/listing/${listing.id}/scanner`);
      const attribute = page.html.match(/data-words="([^"]*)"/)?.[1];
      if (attribute === undefined) throw new Error("The page sends no words.");
      const words = v.parse(
        ScannerWordsSchema,
        JSON.parse(
          attribute.replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
        ),
      );
      for (const [name, { holes }] of Object.entries(SCANNER_WORDS)) {
        const found = [...words[name as WordName].matchAll(/\{(\w+)\}/g)].map(
          (match) => match[1],
        );
        expect([...new Set(found)].sort(), name).toEqual([...holes].sort());
      }
    });

    test("answers private JSON under the site's policy", async () => {
      const app = await loggedIn();
      const listing = await createTestListing();
      const { headers } = await app.get(
        `/admin/listing/${listing.id}/scan-search?q=ab`,
      );
      expectPrivateJson(headers);
    });

    test("names only the listings a person still owes, each with its day", async () => {
      const app = await loggedIn();
      const group = await createTestGroup({ scanChecksInAllListings: true });
      const daily = {
        bookableDays: allDays,
        groupId: group.id,
        listingType: "daily",
        maxAttendees: 10,
        maximumDaysAfter: 60,
        minimumDaysBefore: 0,
      } as const;
      const west = await createTestListing({ ...daily, name: "West" });
      const east = await createTestListing({ ...daily, name: "East" });
      const day = testDate(
        new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
      );
      const sam = await bookTestAttendee(
        [
          { date: day, listingId: west.id, quantity: 2 },
          { date: day, listingId: east.id, quantity: 1 },
        ],
        "Sam Reed",
        "sam@example.com",
      );
      await postAttendeeRefund({ attendeeId: sam.id, listingId: east.id });

      // The refunded line owes nothing: its listing is not named, and its
      // place does not count, though this door checks in every listing.
      expect(await search(app, `/admin/groups/${group.id}`, "?q=sam")).toEqual({
        body: {
          options: [
            {
              attendeeId: sam.id,
              details: [expect.stringMatching(/^West · \S/)],
              name: "Sam Reed",
              quantity: 2,
            },
          ],
        },
        status: 200,
      });
    });

    test("answers 404 for a No check-in listing", async () => {
      const app = await loggedIn();
      const closed = await createTestListing({ purchaseOnly: true });
      const page = await app.get(
        `/admin/listing/${closed.id}/scan-search?q=ab`,
      );
      expect(page.status).toBe(404);
      // The door's routes all answer a missing door with the scan API's
      // own word, which the scanner's answer schema reads.
      expect(JSON.parse(page.html)).toEqual({ status: "not_found" });
    });

    test("answers 401 JSON without a scanner session", async () => {
      const app = createApp(inProcess);
      const response = await app.target(
        new Request("http://localhost/admin/listing/12/scan-search?q=ab", {
          headers: { host: "localhost" },
        }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    });
  },
);
