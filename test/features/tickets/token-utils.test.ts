import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildWalletPassData,
  createTokenRoute,
  extractTokenSegment,
  lookupAttendees,
  lookupSingleTokenPassData,
  parseTokens,
  resolveEntries,
  type TokenEntry,
  verifyTokensWithRealLine,
  WALLET_CACHE_CONTROL,
  withTokenRateLimit,
} from "#routes/tickets/token-utils.ts";
import { getAttendeesByTokens } from "#shared/db/attendees/tokens.ts";
import { getDb } from "#shared/db/client.ts";
import {
  isTokenRateLimited,
  recordTokenFailure,
} from "#shared/db/token-attempts.ts";
import { flushPendingWork, runWithPendingWork } from "#shared/pending-work.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

describe("parseTokens", () => {
  test("splits on +, drops empty segments, and de-duplicates", () => {
    expect(parseTokens("a+b+a")).toEqual(["a", "b"]);
    expect(parseTokens("a++b+")).toEqual(["a", "b"]);
  });

  test("treats a separator-free string as a single token", () => {
    // A "+"→"" mutant would split every character apart.
    expect(parseTokens("abc")).toEqual(["abc"]);
  });

  test("keeps one-character tokens", () => {
    // A length>0 → length>1 mutant would drop "a".
    expect(parseTokens("a+bb")).toEqual(["a", "bb"]);
  });

  test("returns an empty array for an empty string", () => {
    expect(parseTokens("")).toEqual([]);
  });
});

describe("extractTokenSegment", () => {
  test("returns the token segment after the prefix", () => {
    // match[1] is the captured segment; match[0] would be the whole path.
    expect(extractTokenSegment("t", "/t/abc")).toBe("abc");
  });

  test("keeps + separators inside the segment", () => {
    expect(extractTokenSegment("t", "/t/a+b+c")).toBe("a+b+c");
  });

  test("works for any prefix", () => {
    expect(extractTokenSegment("checkin", "/checkin/xyz")).toBe("xyz");
  });

  test("returns null when the prefix does not match", () => {
    expect(extractTokenSegment("t", "/other/abc")).toBeNull();
  });

  test("returns null when there is no segment after the prefix", () => {
    expect(extractTokenSegment("t", "/t/")).toBeNull();
  });
});

describe("createTokenRoute", () => {
  const request = new Request("http://localhost/t/abc");
  const route = createTokenRoute("t", {
    GET: () => new Response("ok"),
  });

  test("returns null when the path has no token segment for the prefix", async () => {
    expect(await route(request, "/other/abc", "GET", undefined)).toBeNull();
  });

  test("returns null when no handler is registered for the method", async () => {
    expect(await route(request, "/t/abc", "POST", undefined)).toBeNull();
  });
});

test("WALLET_CACHE_CONTROL caches for 5 min in browser, 1 hour on CDN", () => {
  expect(WALLET_CACHE_CONTROL).toBe("public, max-age=300, s-maxage=3600");
});

const setBookingDates = (attendeeId: number, startAt: string, endAt: string) =>
  getDb().execute({
    args: [startAt, endAt, attendeeId],
    sql: "UPDATE listing_attendees SET start_at = ?, end_at = ? WHERE attendee_id = ?",
  });

const setBookingQuantity = (attendeeId: number, quantity: number) =>
  getDb().execute({
    args: [quantity, attendeeId],
    sql: "UPDATE listing_attendees SET quantity = ? WHERE attendee_id = ?",
  });

const entriesForToken = async (token: string): Promise<TokenEntry[]> => {
  const attendees = await getAttendeesByTokens([token]);
  return resolveEntries([attendees[0]!]);
};

describeWithEnv("ticket token utils", { db: true }, () => {
  test("resolveEntries expands a booking into an entry and view", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "Bob",
      "bob@example.com",
      2,
    );
    await setBookingDates(
      attendee.id,
      "2026-06-21T09:00:00.000Z",
      "2026-06-23T17:00:00.000Z",
    );

    const entries = await entriesForToken(token);
    expect(entries).toHaveLength(1);
    const { attendee: view, listing: entryListing } = entries[0]!;

    expect(entryListing.id).toBe(listing.id);
    expect(view.id).toBe(attendee.id);
    expect(view.listing_id).toBe(listing.id);
    expect(view.quantity).toBe(2);
    // start_at/end_at are sliced to YYYY-MM-DD.
    expect(view.date).toBe("2026-06-21");
    expect(view.end_date).toBe("2026-06-23");
    // Flags derive from the 0/1 columns.
    expect(view.checked_in).toBe(false);
    expect(view.refunded).toBe(false);
    expect(view.split_logistics_agents).toBe(false);
    // Every PII field is blanked in the view.
    for (const blank of [
      view.name,
      view.email,
      view.phone,
      view.address,
      view.lat,
      view.lng,
      view.payment_id,
      view.special_instructions,
    ]) {
      expect(blank).toBe("");
    }
  });

  test("resolveEntries keeps the null date when a booking has no start/end", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Dee",
      "dee@example.com",
    );

    const [entry] = await entriesForToken(token);
    expect(entry!.attendee.date).toBeNull();
    expect(entry!.attendee.end_date).toBeNull();
  });

  test("resolveEntries drops a zero-quantity booking even with a valid listing", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "Ghost",
      "ghost@example.com",
    );
    await setBookingQuantity(attendee.id, 0);

    expect(await entriesForToken(token)).toEqual([]);
  });

  test("verifyTokensWithRealLine keeps only tokens with a real line", async () => {
    const listingA = await createTestListing({ maxAttendees: 10 });
    const listingB = await createTestListing({ maxAttendees: 10 });
    const real = await createTestAttendeeDirect(
      listingA.id,
      "Real",
      "real@example.com",
      2,
    );
    const sentinel = await createTestAttendeeDirect(
      listingB.id,
      "Sentinel",
      "sentinel@example.com",
    );
    await setBookingQuantity(sentinel.attendee.id, 0);

    const result = await verifyTokensWithRealLine([real.token, sentinel.token]);
    expect(result.verifiedTokens).toEqual([real.token]);
    expect(result.listingIds).toEqual([listingA.id]);
  });

  test("verifyTokensWithRealLine verifies a single real token", async () => {
    // Exactly one token distinguishes `length > 0` from `length > 1`.
    const listing = await createTestListing({ maxAttendees: 10 });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Solo",
      "solo@example.com",
    );

    const result = await verifyTokensWithRealLine([token]);
    expect(result.verifiedTokens).toEqual([token]);
    expect(result.listingIds).toEqual([listing.id]);
  });

  test("verifyTokensWithRealLine returns empty results for no tokens", async () => {
    expect(await verifyTokensWithRealLine([])).toEqual({
      listingIds: [],
      verifiedTokens: [],
    });
  });

  test("lookupAttendees returns the attendees for known tokens", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Kay",
      "kay@example.com",
    );

    const result = await lookupAttendees([token]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.attendees).toHaveLength(1);
  });

  test("lookupAttendees 404s when no token resolves", async () => {
    const result = await lookupAttendees(["nope-not-a-token"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(404);
  });

  test("lookupSingleTokenPassData builds pass data for a lone valid token", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Pat",
      "pat@example.com",
      3,
    );

    const result = await lookupSingleTokenPassData([token]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.passData.serialNumber).toBe(token);
      expect(result.passData.checkinUrl).toBe(buildCheckinUrl(token));
      expect(result.passData.quantity).toBe(3);
      expect(result.passData.listingName).toBe(listing.name);
    }
  });

  test("lookupSingleTokenPassData 404s for an empty token list", async () => {
    const result = await lookupSingleTokenPassData([]);
    expect(result.ok).toBe(false);
  });

  test("lookupSingleTokenPassData 404s for more than one token", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const a = await createTestAttendeeDirect(listing.id, "A", "a@example.com");
    const b = await createTestAttendeeDirect(listing.id, "B", "b@example.com");

    const result = await lookupSingleTokenPassData([a.token, b.token]);
    expect(result.ok).toBe(false);
  });

  test("lookupSingleTokenPassData 404s for an unknown token", async () => {
    const result = await lookupSingleTokenPassData(["nope-not-a-token"]);
    expect(result.ok).toBe(false);
  });

  test("lookupSingleTokenPassData 404s when the token resolves to no real line", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "Empty",
      "empty@example.com",
    );
    await setBookingQuantity(attendee.id, 0);

    const result = await lookupSingleTokenPassData([token]);
    expect(result.ok).toBe(false);
  });

  test("lookupSingleTokenPassData 404s a package booking to avoid leaking a member", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Bundle" });
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "Bundled",
      "bundled@example.com",
    );
    await getDb().execute({
      args: [group.id, attendee.id],
      sql: "UPDATE listing_attendees SET package_group_id = ? WHERE attendee_id = ?",
    });

    const result = await lookupSingleTokenPassData([token]);
    expect(result.ok).toBe(false);
  });

  test("buildWalletPassData maps a resolved entry onto the pass fields", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Wal",
      "wal@example.com",
      4,
    );
    const [entry] = await entriesForToken(token);

    const pass = buildWalletPassData(entry!, token);
    expect(pass.serialNumber).toBe(token);
    expect(pass.checkinUrl).toBe(buildCheckinUrl(token));
    expect(pass.quantity).toBe(4);
    expect(pass.listingName).toBe(listing.name);
  });

  const rateLimitRequest = new Request("http://localhost/t/abc");

  test("withTokenRateLimit returns the handler response and clears failures on success", async () => {
    await runWithPendingWork(async () => {
      const ok = new Response("ok", { status: 200 });
      const out = await withTokenRateLimit(
        rateLimitRequest,
        undefined,
        ["t1"],
        () => ok,
      );
      await flushPendingWork();
      expect(out).toBe(ok);
    });
  });

  test("withTokenRateLimit records a 404 failure and locks the IP", async () => {
    await runWithPendingWork(async () => {
      await withTokenRateLimit(
        rateLimitRequest,
        undefined,
        ["a", "b", "c", "d", "e"],
        () => new Response("nope", { status: 404 }),
      );
      await flushPendingWork();
    });
    expect(await isTokenRateLimited("direct")).toBe(true);
  });

  test("withTokenRateLimit does not record a failure for a non-404 response", async () => {
    await runWithPendingWork(async () => {
      await withTokenRateLimit(
        rateLimitRequest,
        undefined,
        ["a", "b", "c", "d", "e"],
        () => new Response("ok", { status: 200 }),
      );
      await flushPendingWork();
    });
    expect(await isTokenRateLimited("direct")).toBe(false);
  });

  test("withTokenRateLimit counts a single-token 404 toward the limit", async () => {
    await recordTokenFailure("direct", ["a", "b", "c", "d"]);
    expect(await isTokenRateLimited("direct")).toBe(false);

    await runWithPendingWork(async () => {
      await withTokenRateLimit(
        rateLimitRequest,
        undefined,
        ["e"],
        () => new Response("nope", { status: 404 }),
      );
      await flushPendingWork();
    });
    expect(await isTokenRateLimited("direct")).toBe(true);
  });

  test("withTokenRateLimit short-circuits to 429 without running the handler", async () => {
    await recordTokenFailure("direct", ["a", "b", "c", "d", "e"]);
    let ran = false;
    const out = await withTokenRateLimit(
      rateLimitRequest,
      undefined,
      ["x"],
      () => {
        ran = true;
        return new Response("ok");
      },
    );
    expect(out.status).toBe(429);
    expect(ran).toBe(false);
  });
});
