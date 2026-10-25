/**
 * Tests for the scanner's offline ticket-hash cache:
 * GET /admin/listing/:id/scan-cache and GET /admin/groups/:id/scan-cache.
 *
 * The cache is what an offline door validates scans against, so its set is
 * the security boundary between the doors and the device: it carries SHA-256
 * digests only, and only of tokens a scan could admit right now.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { generateTicketToken } from "#crypto/utils.ts";
import { attendeesApi } from "#db/attendees/api.ts";
import { execute } from "#db/client.ts";
import { handleRequest } from "#routes";
import { doorCacheName, pageDoorCacheKey } from "#routes/admin/scan-cache.ts";
import { addDays } from "#shared/dates.ts";
import { hmacHex } from "#shared/sha256.ts";
import { todayInTz } from "#shared/timezone.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

const authedGet = async (path: string): Promise<Response> =>
  awaitTestRequest(path, { cookie: await testCookie() });

/** The digest one door's cache holds for one token: HMAC-SHA256 under the
 * door's derived key, the same construction the device runs. */
const doorDigest = (door: string, token: string): Promise<string> =>
  hmacHex(deriveDoorCacheKey(door), token);

describeWithEnv("the scanner's ticket-hash cache", { db: true }, () => {
  test("serves an entry for every ticket the listing door can admit", async () => {
    const { listing, token: kept } = await createTestAttendeeWithToken(
      "Ada Host",
      "ada@example.com",
    );
    const { token: other } = await createTestAttendeeDirect(
      listing.id,
      "Ben Lane",
      "ben@example.com",
    );
    const body = await assertJson(
      authedGet(`/admin/listing/${listing.id}/scan-cache`),
      200,
    );
    const door = doorCacheName("listing", listing.id);
    expect(body).toEqual({
      entries: (
        await Promise.all([doorDigest(door, kept), doorDigest(door, other)])
      )
        .sort()
        .map((hash) => ({ hash, tickets: 1 })),
    });
  });

  test("saves the set in digest order, not booking order", async () => {
    // Two doors whose tickets book on different days: one door's early day
    // holds the lesser digest, the other's the greater. The read meets one
    // pair already in digest order and one it must turn around, so the
    // served order is the digest order whichever way the days and the
    // digests meet.
    const doorWith = async (
      earlyDayHoldsGreater: boolean,
      people: [string, string],
    ) => {
      const listing = await createTestListing();
      const door = doorCacheName("listing", listing.id);
      // Tokens in the shape a real ticket carries, one fresh pair per door,
      // so the site's one-ticket-token rule never meets the same pair twice.
      const tokenA = generateTicketToken();
      const tokenB = generateTicketToken();
      const digestA = await doorDigest(door, tokenA);
      const digestB = await doorDigest(door, tokenB);
      const [lesserToken, greaterToken] =
        digestA < digestB ? [tokenA, tokenB] : [tokenB, tokenA];
      const [lesserDigest, greaterDigest] =
        digestA < digestB ? [digestA, digestB] : [digestB, digestA];
      const bookToken = async (day: number, name: string, token: string) => {
        const result = await attendeesApi.createAttendeeAtomic({
          bookings: [
            {
              date: addDays(testDate(todayInTz("UTC")), day),
              listingId: listing.id,
              quantity: 1,
            },
          ],
          email: `${name.toLowerCase().replace(/\s+/g, "-")}@example.com`,
          name,
          ticketToken: token,
        });
        if (!result.success) {
          throw new Error(`booking for ${name} failed: ${result.reason}`);
        }
      };
      const [earlyToken, lateToken] = earlyDayHoldsGreater
        ? [greaterToken, lesserToken]
        : [lesserToken, greaterToken];
      await bookToken(2, people[0]!, earlyToken);
      await bookToken(3, people[1]!, lateToken);
      return { greaterDigest, lesserDigest, listing };
    };
    const earlyLesser = await doorWith(false, ["Eve Ash", "Finn Ash"]);
    const earlyGreater = await doorWith(true, ["Gail Ash", "Hugo Ash"]);
    for (const built of [earlyLesser, earlyGreater]) {
      expect(
        await assertJson(
          authedGet(`/admin/listing/${built.listing.id}/scan-cache`),
          200,
        ),
      ).toEqual({
        entries: [
          { hash: built.lesserDigest, tickets: 1 },
          { hash: built.greaterDigest, tickets: 1 },
        ],
      });
    }
  });

  test("carries the places each booking still owes the door", async () => {
    const { listing, token } = await createTestAttendeeWithToken(
      "Ada Host",
      "ada@example.com",
      {},
      3,
    );
    const body = await assertJson(
      authedGet(`/admin/listing/${listing.id}/scan-cache`),
      200,
    );
    expect(body.entries).toEqual([
      {
        hash: await doorDigest(doorCacheName("listing", listing.id), token),
        tickets: 3,
      },
    ]);
  });

  /** One two-listing group door with one person holding two places at the
   * first listing and three at the second. Answers the door's saved list
   * and the digest it holds for the person's token. */
  const twoListingDoorCache = async (
    groupName: string,
    scanChecksInAllListings: boolean,
    guest: string,
    email: string,
  ) => {
    const group = await createTestGroup({
      name: groupName,
      scanChecksInAllListings,
    });
    const west = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: `${groupName} West ${group.id}`,
    });
    const east = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: `${groupName} East ${group.id}`,
    });
    const attendee = await createMultiBookingAttendee(guest, email, [
      { listingId: west.id, quantity: 2 },
      { listingId: east.id, quantity: 3 },
    ]);
    const body = await assertJson(
      authedGet(`/admin/groups/${group.id}/scan-cache`),
      200,
    );
    return {
      attendee,
      body,
      digest: await doorDigest(
        doorCacheName("group", group.id),
        attendee.ticket_token,
      ),
    };
  };

  test("bounds a multi-listing booking at a one-listing-per-scan door to the first listing's places", async () => {
    // Each scan at this door checks in one listing at a time, so one scan
    // admits only the first listing's places. The saved list bounds the
    // door's ask at those places, so the delivery it names lands whole.
    const { body, digest } = await twoListingDoorCache(
      "Bound Barn",
      false,
      "Gus Reed",
      "gus@example.com",
    );
    expect(body.entries).toEqual([{ hash: digest, tickets: 2 }]);
  });

  test("keeps a multi-listing booking's whole total at a check-every-listing door", async () => {
    // One scan at this door checks in every listing the ticket holds, so
    // the saved list keeps the booking's whole total as the ask's bound.
    const { body, digest } = await twoListingDoorCache(
      "Whole Barn",
      true,
      "Hana Reed",
      "hana@example.com",
    );
    expect(body.entries).toEqual([{ hash: digest, tickets: 5 }]);
  });

  test("names the first listing's places when an earlier line on it is fully checked in", async () => {
    // One person holds two lines on the first listing and one line on the
    // second. The first listing's early line is fully checked in, and the
    // second listing's line starts between the first listing's two lines.
    // One scan at this door still lands on the first listing, so the saved
    // count names that listing's remaining places, not the second listing's.
    const group = await createTestGroup({
      name: "Order Barn",
      scanChecksInAllListings: false,
    });
    const west = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: `Order Barn West ${group.id}`,
    });
    const east = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: `Order Barn East ${group.id}`,
    });
    // Each line books its own day, so the read's start order is a fact: the
    // first listing's early line, the second listing's line, then the first
    // listing's later line.
    const bookingDay = (offset: number) =>
      addDays(testDate(todayInTz("UTC")), 2 + offset);
    const result = await attendeesApi.createAttendeeAtomic({
      bookings: [
        { date: bookingDay(0), listingId: west.id, quantity: 2 },
        { date: bookingDay(1), listingId: east.id, quantity: 4 },
        { date: bookingDay(2), listingId: west.id, quantity: 3 },
      ],
      email: "ivy@example.com",
      name: "Ivy Reed",
    });
    if (!result.success) {
      throw new Error(`booking for Ivy failed: ${result.reason}`);
    }
    const attendee = result.attendees[0]!;
    // The early line on the first listing holds no places the door can
    // still admit: both of its places are checked in.
    await execute(
      "UPDATE listing_attendees SET checked_in = quantity WHERE attendee_id = ? AND quantity = 2",
      [attendee.id],
    );
    const body = await assertJson(
      authedGet(`/admin/groups/${group.id}/scan-cache`),
      200,
    );
    expect(body.entries).toEqual([
      {
        hash: await doorDigest(
          doorCacheName("group", group.id),
          attendee.ticket_token,
        ),
        tickets: 3,
      },
    ]);
  });

  test("leaves a checked-in ticket out of the set", async () => {
    const { listing, token: checked } = await createTestAttendeeWithToken(
      "Cara Vale",
      "cara@example.com",
    );
    const { token: waiting } = await createTestAttendeeDirect(
      listing.id,
      "Dan Ford",
      "dan@example.com",
    );
    const checkIn = await handleRequest(
      requestAsSession(
        `/admin/listing/${listing.id}/scan`,
        { cookie: await testCookie(), csrfToken: await testCsrfToken() },
        {
          body: JSON.stringify({ token: checked }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
    );
    expect(checkIn.status).toBe(200);

    const body = await assertJson(
      authedGet(`/admin/listing/${listing.id}/scan-cache`),
      200,
    );
    expect(body.entries).toEqual([
      {
        hash: await doorDigest(doorCacheName("listing", listing.id), waiting),
        tickets: 1,
      },
    ]);
  });

  test("serves a group door's tokens across its member listings", async () => {
    const group = await createTestGroup({ name: "West Barn" });
    const west = await createTestListing({ groupId: group.id });
    const east = await createTestListing({ groupId: group.id });
    const { token: first } = await createTestAttendeeDirect(
      west.id,
      "Eve Ray",
      "eve@example.com",
    );
    const { token: second } = await createTestAttendeeDirect(
      east.id,
      "Finn Ash",
      "finn@example.com",
    );
    const body = await assertJson(
      authedGet(`/admin/groups/${group.id}/scan-cache`),
      200,
    );
    const door = doorCacheName("group", group.id);
    expect(body.entries).toEqual(
      (await Promise.all([doorDigest(door, first), doorDigest(door, second)]))
        .sort()
        .map((hash) => ({ hash, tickets: 1 })),
    );
  });

  test("never carries the door's cache key in the response", async () => {
    const { listing } = await createTestAttendeeWithToken(
      "Ada Host",
      "ada@example.com",
    );
    const response = await authedGet(`/admin/listing/${listing.id}/scan-cache`);
    const text = await response.text();
    // The page alone carries the key, so a copied cache response digests
    // nothing by itself.
    assert(
      !text.includes(pageDoorCacheKey(doorCacheName("listing", listing.id))),
    );
  });

  test("carries the listing door's cache key on its scanner page", async () => {
    const { listing } = await createTestAttendeeWithToken(
      "Ada Host",
      "ada@example.com",
    );
    const response = await authedGet(`/admin/listing/${listing.id}/scanner`);
    // The page is the only response that carries the key, so the device can
    // digest a scan offline under the same key the cache digested with.
    assertStringIncludes(
      await response.text(),
      `data-door-cache-key="${pageDoorCacheKey(
        doorCacheName("listing", listing.id),
      )}"`,
    );
  });

  test("answers 404 for a No check-in listing's cache", async () => {
    const listing = await createTestListing({ purchaseOnly: true });
    const response = await authedGet(`/admin/listing/${listing.id}/scan-cache`);
    expect(response.status).toBe(404);
  });

  test("answers 404 for an unknown group's cache", async () => {
    const response = await authedGet("/admin/groups/999999/scan-cache");
    expect(response.status).toBe(404);
  });

  test("answers 401 without a scanner session", async () => {
    const { listing } = await createTestAttendeeWithToken(
      "Gail Moor",
      "gail@example.com",
    );
    const response = await handleRequest(
      new Request(`http://localhost/admin/listing/${listing.id}/scan-cache`, {
        headers: { host: "localhost" },
      }),
    );
    expect(response.status).toBe(401);
  });
});
