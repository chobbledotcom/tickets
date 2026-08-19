import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { getDb } from "#db/client.ts";
import { isTokenRateLimited, recordTokenFailure } from "#db/token-attempts.ts";
import {
  buildWalletPassData,
  lookupAttendees,
  lookupSingleTokenPassData,
  resolveEntries,
  type TokenEntry,
  verifyTokensWithRealLine,
  withTokenRateLimit,
} from "#routes/tickets/token-utils.ts";
import { MAX_TOKEN_404S } from "#shared/limits.ts";
import { flushPendingWork, runWithPendingWork } from "#shared/pending-work.ts";
import { buildCheckinUrl } from "#shared/ticket-url.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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

const expectPassLookupNotFound = async (tokens: string[]): Promise<void> => {
  const result = await lookupSingleTokenPassData(tokens);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(404);
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

  test("resolveEntries returns no entries when the attendee has no bookings", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "No booking",
      "nobooking@example.com",
    );
    await getDb().execute({
      args: [attendee.id],
      sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
    });

    const attendees = await getAttendeesByTokens([token]);
    expect(await resolveEntries([attendees[0]!])).toEqual([]);
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
    await expectPassLookupNotFound([]);
  });

  test("lookupSingleTokenPassData 404s for more than one token", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const a = await createTestAttendeeDirect(listing.id, "A", "a@example.com");
    const b = await createTestAttendeeDirect(listing.id, "B", "b@example.com");

    await expectPassLookupNotFound([a.token, b.token]);
  });

  test("lookupSingleTokenPassData 404s for an unknown token", async () => {
    await expectPassLookupNotFound(["nope-not-a-token"]);
  });

  test("lookupSingleTokenPassData 404s when the token resolves to no real line", async () => {
    const listing = await createTestListing({ maxAttendees: 10 });
    const { attendee, token } = await createTestAttendeeDirect(
      listing.id,
      "Empty",
      "empty@example.com",
    );
    await setBookingQuantity(attendee.id, 0);

    await expectPassLookupNotFound([token]);
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

    await expectPassLookupNotFound([token]);
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
  // Distinct token lists sized off the configurable lockout threshold, so the
  // tests hold whatever MAX_TOKEN_404S is set to.
  const distinctTokens = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `tok-${i}`);
  const atLimit = distinctTokens(MAX_TOKEN_404S);
  const belowLimit = distinctTokens(MAX_TOKEN_404S - 1);
  const oneMore = `tok-${MAX_TOKEN_404S - 1}`;

  // Run the rate limiter under a pending-work scope and flush the queued
  // failure/clear write so its effect is observable, returning the response.
  const runRateLimited = (
    tokens: string[],
    response: Response,
  ): Promise<Response> =>
    runWithPendingWork(async () => {
      const out = await withTokenRateLimit(
        rateLimitRequest,
        undefined,
        tokens,
        () => response,
      );
      await flushPendingWork();
      return out;
    });

  test("withTokenRateLimit returns the handler response and clears failures on success", async () => {
    // One short of the lockout threshold.
    await recordTokenFailure("direct", belowLimit);

    const ok = new Response("ok", { status: 200 });
    expect(await runRateLimited(["t1"], ok)).toBe(ok);

    // Clearing is only observable when more than one failure is allowed; with
    // MAX_TOKEN_404S = 1 there is no below-limit state to have cleared. When it
    // is higher, the success wiped the prior failures, so one fresh failure
    // cannot lock — had clearing been skipped, this token would trip it.
    if (MAX_TOKEN_404S > 1) {
      await recordTokenFailure("direct", [oneMore]);
      expect(await isTokenRateLimited("direct")).toBe(false);
    }
  });

  test("withTokenRateLimit records a 404 failure and locks the IP", async () => {
    await runRateLimited(atLimit, new Response("nope", { status: 404 }));
    expect(await isTokenRateLimited("direct")).toBe(true);
  });

  test("withTokenRateLimit does not record a failure for a non-OK, non-404 response", async () => {
    // A 500 takes neither the 404-record branch nor the 2xx-clear branch.
    await runRateLimited(atLimit, new Response("boom", { status: 500 }));
    expect(await isTokenRateLimited("direct")).toBe(false);
  });

  test("withTokenRateLimit counts a single-token 404 toward the limit", async () => {
    await recordTokenFailure("direct", belowLimit);
    expect(await isTokenRateLimited("direct")).toBe(false);

    await runRateLimited([oneMore], new Response("nope", { status: 404 }));
    expect(await isTokenRateLimited("direct")).toBe(true);
  });

  test("withTokenRateLimit short-circuits to 429 without running the handler", async () => {
    await recordTokenFailure("direct", atLimit);
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
