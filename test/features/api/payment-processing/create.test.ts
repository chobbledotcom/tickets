import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  createAttendeeForSession,
  pairEntriesByListing,
} from "#routes/api/payment-processing/create.ts";
import { specForFailure } from "#routes/api/payment-processing/store-refund.ts";
import { testListingWithCount, webhookMeta } from "#test-utils/factories.ts";

/** A validated item carries a listing (the only field the pairing reads). */
const item = (id: number) => ({ listing: testListingWithCount({ id }) });
/** A created booking row — the pairing keys on its `listing_id`. */
const row = (listing_id: number) => ({ listing_id });

describe("pairEntriesByListing", () => {
  test("pairs a one-row-per-item order by listing id", () => {
    const items = [item(10), item(20)];
    const entries = pairEntriesByListing([row(20), row(10)], items);
    // Order-independent: each row resolves to its own listing, not the item at
    // the same array index.
    expect(entries.map((e) => e.attendee.listing_id)).toEqual([20, 10]);
    expect(entries.map((e) => e.listing.id)).toEqual([20, 10]);
  });

  test("maps MORE rows than items — the multi-parent expansion — without mis-aligning", () => {
    // A child (30) chosen under two parents (10, 20) is ONE signed item but TWO
    // per-parent booking rows, so four rows resolve against three items. A
    // positional `validatedItems[i]` pairing would read `validatedItems[3]`
    // (undefined) and throw; the by-id lookup pairs every row correctly.
    const items = [item(10), item(20), item(30)];
    const attendees = [row(10), row(20), row(30), row(30)];
    const entries = pairEntriesByListing(attendees, items);
    expect(entries).toHaveLength(4);
    // Every entry's listing matches its own row's listing id — including both
    // child rows, which share listing 30.
    expect(entries.every((e) => e.attendee.listing_id === e.listing.id)).toBe(
      true,
    );
    expect(entries.filter((e) => e.listing.id === 30)).toHaveLength(2);
  });

  test("resolves a parent-less remainder row (same listing, extra row) too", () => {
    // A remainder row shares the child's listing id (30) with its allocation
    // row, so both resolve to listing 30 — again more rows than items.
    const entries = pairEntriesByListing(
      [row(10), row(30), row(30)],
      [item(10), item(30)],
    );
    expect(entries.map((e) => e.listing.id)).toEqual([10, 30, 30]);
  });
});

const preparationResult = (options: {
  matchingPricedItem: boolean;
  sessionId: string;
  total: number;
}) => {
  const listing = testListingWithCount({ id: 1, unit_price: 1000 });
  const bookingItem = { e: listing.id, p: 1000, q: 1 };
  const checkoutItem = {
    listingId: listing.id,
    name: listing.name,
    quantity: 1,
    slug: listing.slug,
    unitPrice: 1000,
  };
  const contact = {
    address: "",
    date: null,
    email: "buyer@example.com",
    name: "Buyer",
    phone: "",
    special_instructions: "",
  };
  const session = {
    amountTotal: 1000,
    id: options.sessionId,
    metadata: webhookMeta({ name: "Buyer" }),
    paymentReference: `pi_${options.sessionId}`,
    paymentStatus: "paid" as const,
  };
  return createAttendeeForSession(
    session,
    { ...contact, items: [bookingItem], modifiers: [] },
    [{ expectedPrice: 1000, item: bookingItem, listing }],
    { ...contact, items: [checkoutItem] },
    {
      extras: [],
      fullSubtotal: 1000,
      lines: [
        {
          chargedUnitAmount: 1000,
          item: options.matchingPricedItem ? checkoutItem : { ...checkoutItem },
          quantity: 1,
        },
      ],
      modifierApplications: [],
      total: options.total,
    },
    {
      attendeeId: 1,
      createdAt: "2026-07-17T00:00:00.000Z",
      paymentSessionId: session.id,
      provider: "stripe",
      providerCheckoutId: session.id,
      refund: null,
      state: "pending",
      ticketToken: "stable-ticket-token",
    },
  );
};

test("reports a preparation error before the atomic write starts", async () => {
  const result = await preparationResult({
    matchingPricedItem: true,
    sessionId: "cs_preparation_failure",
    total: Number.NaN,
  });
  expect(result).toEqual({
    detail:
      "Unexpected error preparing session cs_preparation_failure: Error: mapBooking: invalid facts (non-finite amountPaid)",
    ok: false,
    reason: "unexpected_error",
  });
  if (result.ok !== false) throw new Error("Expected preparation to fail");
  expect(specForFailure(result).code).toBe("unexpected_error");
});

test("reports a preparation error when a paid amount was not loaded", async () => {
  const result = await preparationResult({
    matchingPricedItem: false,
    sessionId: "cs_missing_paid_amount",
    total: 1000,
  });
  expect(result).toEqual({
    detail:
      "Unexpected error preparing session cs_missing_paid_amount: Error: Paid amount for checkout item 0 was not loaded",
    ok: false,
    reason: "unexpected_error",
  });
});
