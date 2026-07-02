import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  createAttendeeAtomic,
  decryptAttendees,
  getAttendeeRaw,
  getAttendeesRaw,
} from "#shared/db/attendees.ts";
import { dateToRange } from "#shared/db/capacity.ts";
import { getDb } from "#shared/db/client.ts";
import { updateListingAggregateValues } from "#shared/db/listings.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import {
  createDailyTestListing,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";
import { postListingSale } from "#test-utils/ledger.ts";

/** Fetch raw start_at/end_at for an listing (getAttendeesRaw drops them). */
const getRange = async (
  listingId: number,
): Promise<{ start_at: string; end_at: string }> => {
  const res = await getDb().execute({
    args: [listingId],
    sql: "SELECT start_at, end_at FROM listing_attendees WHERE listing_id = ?",
  });
  return res.rows[0] as unknown as { start_at: string; end_at: string };
};

/** Assert the cart succeeded with one attendee per `[listingId, quantity]` pair,
 * each listing's first row holding that quantity. */
const expectCartRows = async (
  result: Awaited<ReturnType<typeof createAttendeeAtomic>>,
  rows: [number, number][],
): Promise<void> => {
  expect(result.success).toBe(true);
  if (result.success) expect(result.attendees.length).toBe(rows.length);
  for (const [listingId, quantity] of rows) {
    expect((await getAttendeesRaw(listingId))[0]!.quantity).toBe(quantity);
  }
};

const setupBookedOutListing = async () => {
  const listing = await createTestListing({ maxAttendees: 1 });
  await updateListingAggregateValues(listing.id, {
    booked_quantity: 1,
    tickets_count: 0,
  });
  return listing;
};

describeWithEnv("db > attendees > createAttendeeAtomic", { db: true }, () => {
  test("succeeds when capacity available", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      thankYouUrl: "https://example.com",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 2 }],
      email: "john@example.com",
      name: "John",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.attendees.length).toBe(1);
      expect(result.attendees[0]!.name).toBe("John");
    }
  });

  test("a package booking's package_group_id survives the attendee join selects", async () => {
    // The booking-row loader carries package_group_id, but the attendee join
    // selects must hydrate it too — otherwise a re-sent notification for a
    // hidden package booking treats the row as a standalone member and can leak
    // the hidden listing or its base price.
    const group = await createTestGroup({ isPackage: true, name: "Pkg" });
    const listing = await createTestListing({ groupId: group.id });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "buyer@example.com",
      name: "Buyer",
      packageGroupId: group.id,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    // INNER join select (getAttendeesRaw) and LEFT join select (getAttendeeRaw).
    expect((await getAttendeesRaw(listing.id))[0]!.package_group_id).toBe(
      group.id,
    );
    const byId = await getAttendeeRaw(result.attendees[0]!.id);
    expect(byId!.package_group_id).toBe(group.id);
  });

  test("records a contact visit for a real booking", async () => {
    const { getVisits, hashEmail } = await import(
      "#shared/db/contact-preferences.ts"
    );
    const listing = await createTestListing({ maxAttendees: 5 });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "visitor@example.com",
      name: "Visitor",
    });
    expect(result.success).toBe(true);
    expect(await getVisits(await hashEmail("visitor@example.com"))).toBe(1);
  });

  test("records NO visit for a no-quantity-only attendee", async () => {
    // A placeholder/cancelled (quantity-0-only) order is not a real visit —
    // counting it would let a ghost-only contact qualify as returning via the
    // min_visits modifier gating.
    const { getVisits, hashEmail } = await import(
      "#shared/db/contact-preferences.ts"
    );
    const listing = await createTestListing({ maxAttendees: 5 });
    const result = await createAttendeeAtomic({
      allowOverbook: true,
      bookings: [{ listingId: listing.id, quantity: 0 }],
      email: "ghostonly@example.com",
      name: "Ghost Only",
      source: "admin",
    });
    expect(result.success).toBe(true);
    expect(await getVisits(await hashEmail("ghostonly@example.com"))).toBe(0);
  });

  test("links single attendee record to multiple listings for group purchase", async () => {
    const listing1 = await createTestListing({ maxAttendees: 10 });
    const listing2 = await createTestListing({ maxAttendees: 10 });

    const result = await createAttendeeAtomic({
      bookings: [
        { listingId: listing1.id, quantity: 2 },
        { listingId: listing2.id, quantity: 3 },
      ],
      email: "multi@example.com",
      name: "Multi Buyer",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Both booking results point to the same underlying attendee row
    expect(result.attendees.length).toBe(2);
    const attendeeId = result.attendees[0]!.id;
    expect(result.attendees[1]!.id).toBe(attendeeId);

    const listing1Raw = await getAttendeesRaw(listing1.id);
    expect(listing1Raw.length).toBe(1);
    expect(listing1Raw[0]!.id).toBe(attendeeId);
    expect(listing1Raw[0]!.quantity).toBe(2);

    const listing2Raw = await getAttendeesRaw(listing2.id);
    expect(listing2Raw.length).toBe(1);
    expect(listing2Raw[0]!.id).toBe(attendeeId);
    expect(listing2Raw[0]!.quantity).toBe(3);
  });

  test("fails when capacity exceeded", async () => {
    const listing = await createTestListing({
      maxAttendees: 1,
      thankYouUrl: "https://example.com",
    });
    await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "first@example.com",
      name: "First",
    });

    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "second@example.com",
      name: "Second",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capacity_exceeded");
    }
  });

  test("fails with empty bookings", async () => {
    const result = await createAttendeeAtomic({
      bookings: [],
      email: "nobody@example.com",
      name: "Nobody",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("capacity_exceeded");
    }
  });

  test("fails when encryption key not configured", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
    });

    await getDb().execute({
      args: [CONFIG_KEYS.PUBLIC_KEY],
      sql: "DELETE FROM settings WHERE key = ?",
    });
    settings.invalidateCache();

    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id }],
      email: "john@example.com",
      name: "John",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe("encryption_error");
    }
  });

  test("stores and returns price_paid when provided", async () => {
    const listing = await createTestListing({
      maxAttendees: 50,
      thankYouUrl: "https://example.com",
      unitPrice: 2500,
    });

    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 2500, quantity: 1 }],
      email: "pay@example.com",
      name: "Paying Customer",
      paymentId: "pi_test_price",
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attendees[0]!.price_paid).toBe("2500");

    // price_paid is a ledger projection now: in production checkout-complete
    // posts the sale leg in the same transaction. Mirror that so the per-row
    // amount-paid projection resolves this booking's sale.
    await postListingSale({
      attendeeId: result.attendees[0]!.id,
      gross: 2500,
      listingId: listing.id,
    });

    const privateKey = await getTestPrivateKey();
    const raw = await getAttendeesRaw(listing.id);
    const attendees = await decryptAttendees(raw, privateKey);
    expect(attendees[0]?.price_paid).toBe("2500");
  });

  test("stores end_at = start_at + duration days for daily multi-day bookings", async () => {
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 5,
      maximumDaysAfter: 30,
    });
    await createAttendeeAtomic({
      bookings: [
        {
          date: "2026-05-01",
          durationDays: 3,
          listingId: listing.id,
          quantity: 1,
        },
      ],
      email: "range@example.com",
      name: "Range",
    });
    const { start_at, end_at } = await getRange(listing.id);
    expect(start_at).toBe("2026-05-01T00:00:00Z");
    expect(end_at).toBe("2026-05-04T00:00:00.000Z");
  });

  test("year-boundary range stores end_at correctly", async () => {
    const listing = await createDailyTestListing({
      durationDays: 7,
      maxAttendees: 2,
      maximumDaysAfter: 400,
    });
    await createAttendeeAtomic({
      bookings: [
        {
          date: "2026-12-30",
          durationDays: 7,
          listingId: listing.id,
          quantity: 1,
        },
      ],
      email: "ny@example.com",
      name: "NewYear",
    });
    const { start_at, end_at } = await getRange(listing.id);
    expect(start_at).toBe("2026-12-30T00:00:00Z");
    expect(end_at).toBe("2027-01-06T00:00:00.000Z");
  });

  test("boundary: day-N end does not overlap another booking starting on day N", async () => {
    // Two 1-day bookings back-to-back at cap=1. start_at strict <, end_at
    // strict > — the second must fit.
    const listing = await createDailyTestListing({
      maxAttendees: 1,
      maximumDaysAfter: 30,
    });
    const a = await createAttendeeAtomic({
      bookings: [{ date: "2026-05-01", listingId: listing.id, quantity: 1 }],
      email: "a@example.com",
      name: "A",
    });
    expect(a.success).toBe(true);
    const b = await createAttendeeAtomic({
      bookings: [{ date: "2026-05-02", listingId: listing.id, quantity: 1 }],
      email: "b@example.com",
      name: "B",
    });
    expect(b.success).toBe(true);
  });

  test("atomic SQL rejects a multi-day booking spanning a full day (no preflight)", async () => {
    // Bypass checkBatchAvailability and stress the inline capacity check in
    // the INSERT: day 2 at cap, 3-day booking starting day 1 must reject.
    const listing = await createDailyTestListing({
      durationDays: 3,
      maxAttendees: 2,
      maximumDaysAfter: 30,
    });
    await createAttendeeAtomic({
      bookings: [
        {
          date: "2026-05-02",
          durationDays: 1,
          listingId: listing.id,
          quantity: 2,
        },
      ],
      email: "mid@example.com",
      name: "Mid",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        {
          date: "2026-05-01",
          durationDays: 3,
          listingId: listing.id,
          quantity: 1,
        },
      ],
      email: "span@example.com",
      name: "Span",
    });
    expect(result.success).toBe(false);
  });

  test("atomic SQL uses editable booked quantity for date-less capacity", async () => {
    const listing = await setupBookedOutListing();
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "manual-full@example.com",
      name: "Manual Full",
    });
    expect(result.success).toBe(false);
  });

  test("atomic SQL uses editable booked quantity for dated standard listings", async () => {
    const listing = await setupBookedOutListing();
    const result = await createAttendeeAtomic({
      bookings: [{ date: "2026-05-01", listingId: listing.id, quantity: 1 }],
      email: "dated-standard-full@example.com",
      name: "Dated Standard Full",
    });
    expect(result.success).toBe(false);
  });

  test("concurrent at-capacity inserts: only one wins", async () => {
    const listing = await createTestListing({ maxAttendees: 1 });
    const [a, b] = await Promise.all([
      createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "a@example.com",
        name: "A",
      }),
      createAttendeeAtomic({
        bookings: [{ listingId: listing.id, quantity: 1 }],
        email: "b@example.com",
        name: "B",
      }),
    ]);
    expect([a.success, b.success].filter(Boolean).length).toBe(1);
  });

  test("rejects negative quantities (defensive guard at library boundary)", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });
    const result = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: -1 }],
      email: "neg@example.com",
      name: "Neg",
    });
    expect(result.success).toBe(false);
  });

  test("rejects duplicate (listing, date) rows in one cart", async () => {
    // The listing_attendees unique index is (listing_id, attendee_id, start_at)
    // — two rows with the same tuple would violate it and silently deliver
    // a half-fulfilled booking. Reject upfront so the caller merges qty.
    const listing = await createDailyTestListing({
      maxAttendees: 10,
      maximumDaysAfter: 30,
    });
    const dup = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", listingId: listing.id, quantity: 1 },
        { date: "2026-05-01", listingId: listing.id, quantity: 1 },
      ],
      email: "dup@example.com",
      name: "Dup",
    });
    expect(dup.success).toBe(false);
    // Different dates on the same listing are fine.
    const ok = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", listingId: listing.id, quantity: 1 },
        { date: "2026-05-02", listingId: listing.id, quantity: 1 },
      ],
      email: "ok@example.com",
      name: "Ok",
    });
    expect(ok.success).toBe(true);
    // Same (listing, date) but different parentListingId — two child rows for
    // the same child under two parents — are distinct slots and are accepted.
    const same = await createAttendeeAtomic({
      bookings: [
        {
          date: "2026-05-01",
          listingId: listing.id,
          parentListingId: 10,
          quantity: 1,
        },
        {
          date: "2026-05-01",
          listingId: listing.id,
          parentListingId: 20,
          quantity: 1,
        },
      ],
      email: "same@example.com",
      name: "Same",
    });
    expect(same.success).toBe(true);
  });

  test("intra-cart group cap: a sibling insert earlier in the same batch counts (no oversell)", async () => {
    // Two listings share a group capped at 3. A single cart asks for 2 + 2 = 4.
    // The second INSERT's capacity check must see the first INSERT from the
    // same atomic batch, so it is refused — booking the first line (2) and
    // declining the second rather than overselling the group to 4. The
    // all-or-nothing policy lives one layer up (ensureAllBookings); this layer
    // fulfils greedily but must never exceed the cap.
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-accum",
      slug: "cart-accum",
    });
    const e1 = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-accum-a",
    });
    const e2 = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-accum-b",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { listingId: e1.id, quantity: 2 },
        { listingId: e2.id, quantity: 2 },
      ],
      email: "cart@example.com",
      name: "Cart",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.attendees.length).toBe(1);
    expect((await getAttendeesRaw(e1.id))[0]!.quantity).toBe(2);
    expect((await getAttendeesRaw(e2.id)).length).toBe(0);
  });

  test("intra-cart group cap: a cart that exactly fills the group across listings succeeds", async () => {
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-fill",
      slug: "cart-fill",
    });
    const e1 = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-fill-a",
    });
    const e2 = await createTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-fill-b",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { listingId: e1.id, quantity: 1 },
        { listingId: e2.id, quantity: 2 },
      ],
      email: "fill@example.com",
      name: "Fill",
    });
    await expectCartRows(result, [
      [e1.id, 1],
      [e2.id, 2],
    ]);
  });

  test("intra-cart group cap is per-date for daily listings booked on the same day", async () => {
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-daily",
      slug: "cart-daily",
    });
    const e1 = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-daily-a",
    });
    const e2 = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-daily-b",
    });
    const result = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", listingId: e1.id, quantity: 2 },
        { date: "2026-05-01", listingId: e2.id, quantity: 2 },
      ],
      email: "daily-cart@example.com",
      name: "DailyCart",
    });
    // 2 + 2 = 4 on the same date > cap 3: first fits, second refused.
    expect(result.success).toBe(true);
    if (result.success) expect(result.attendees.length).toBe(1);
    expect((await getAttendeesRaw(e1.id)).length).toBe(1);
    expect((await getAttendeesRaw(e2.id)).length).toBe(0);
  });

  test("intra-cart daily group cap is independent across different dates", async () => {
    const group = await createTestGroup({
      maxAttendees: 3,
      name: "cart-daily-dates",
      slug: "cart-daily-dates",
    });
    const e1 = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-dates-a",
    });
    const e2 = await createDailyTestListing({
      groupId: group.id,
      maxAttendees: 10,
      name: "cart-dates-b",
    });
    // Each day independently holds 3; both lines sit exactly at the per-day cap.
    const result = await createAttendeeAtomic({
      bookings: [
        { date: "2026-05-01", listingId: e1.id, quantity: 3 },
        { date: "2026-05-02", listingId: e2.id, quantity: 3 },
      ],
      email: "spread@example.com",
      name: "Spread",
    });
    await expectCartRows(result, [
      [e1.id, 3],
      [e2.id, 3],
    ]);
  });

  test("dateToRange produces half-open [start, end) with 1-day default", () => {
    expect(dateToRange("2026-04-15")).toEqual({
      endAt: "2026-04-16T00:00:00.000Z",
      startAt: "2026-04-15T00:00:00Z",
    });
    expect(dateToRange("2026-04-15", 3)).toEqual({
      endAt: "2026-04-18T00:00:00.000Z",
      startAt: "2026-04-15T00:00:00Z",
    });
  });

  test("blocks overbooking by default but allows it when opted in", async () => {
    const listing = await createTestListing({ maxAttendees: 1 });
    const fill = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "",
      name: "Fill",
    });
    expect(fill.success).toBe(true);

    // Default (public/webhook): the capacity guard blocks the second booking.
    const blocked = await createAttendeeAtomic({
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "",
      name: "Blocked",
    });
    expect(blocked.success).toBe(false);

    // allowOverbook (admin manual add): the row is inserted anyway.
    const over = await createAttendeeAtomic({
      allowOverbook: true,
      bookings: [{ listingId: listing.id, quantity: 1 }],
      email: "",
      name: "Over",
    });
    expect(over.success).toBe(true);
    expect((await getAttendeesRaw(listing.id)).length).toBe(2);
  });
});
