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
import { handleRequest } from "#routes";
import { doorCacheName, pageDoorCacheKey } from "#routes/admin/scan-cache.ts";
import { hmacHex } from "#shared/sha256.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
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
