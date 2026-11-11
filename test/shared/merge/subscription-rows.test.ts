/** An attendee merge keeps each subscription plan, and refuses to throw away a
 * booking whose subscription still charges. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import type { AttendeeMergeDiffBookingItem } from "#shared/merge/attendee-merge-types.ts";
import { copiedBookingColumns } from "#shared/merge/booking-copy.ts";
import { droppedSubscriptionErrors } from "#shared/merge/subscription-rows.ts";
import { bookingRow } from "#test-utils/factories.ts";

const LIVE_ERROR =
  "Listing #5: This booking has a subscription that still charges. Cancel the subscription first.";

const row = (status: string): ListingAttendeeRow =>
  bookingRow({
    listing_id: 5,
    subscription_id: status === "" ? "" : "sub_ada",
    subscription_status: status,
  });

const item = (
  source: string,
  target: string | null,
): AttendeeMergeDiffBookingItem => ({
  conflictClass: target === null ? "moveable" : "duplicate",
  listingId: 5,
  packageGroupId: 0,
  parentListingId: 0,
  sourceBooking: row(source),
  sourceSaleAmount: 0,
  startAt: null,
  targetBooking: target === null ? null : row(target),
  targetSaleAmount: 0,
});

const copies = () => true;
const keeps = () => false;

/** Every column a copy keeps, each with a value that differs from the
 * default row. */
const COPIED = {
  attachment_downloads: 2,
  end_at: "2026-06-02",
  ledger_event_group: "grp",
  listing_id: 5,
  order_token: "ord",
  package_group_id: 3,
  parent_listing_id: 4,
  quantity: 2,
  recurring_interval: "month",
  recurring_price: 600,
  recurring_tax: 100,
  start_at: "2026-06-01",
  subscription_id: "sub_ada",
  subscription_status: "active",
};

/** Each merge decision, and the errors it gets. */
const DECISIONS = [
  {
    choice: copies,
    errors: [],
    item: item("active", null),
    name: "lets a live booking move to the target",
  },
  {
    choice: keeps,
    errors: [LIVE_ERROR],
    item: item("active", ""),
    name: "refuses to keep the target over a live source booking",
  },
  {
    choice: copies,
    errors: [LIVE_ERROR],
    item: item("", "past_due"),
    name: "refuses to copy the source over a live target booking",
  },
];

describe("subscription rows in an attendee merge", () => {
  test("a copied booking keeps its booking columns and its whole plan", () => {
    expect(copiedBookingColumns(bookingRow(COPIED))).toEqual(COPIED);
  });

  test("a copied booking leaves out a column that only a read computes", () => {
    const tokenRow = { ...bookingRow(COPIED), email_owed: 1 };
    expect(copiedBookingColumns(tokenRow)).toEqual(COPIED);
  });

  for (const decision of DECISIONS) {
    test(decision.name, () => {
      expect(
        droppedSubscriptionErrors([decision.item], decision.choice),
      ).toEqual(decision.errors);
    });
  }

  test("lets a merge throw away a booking whose subscription ended", () => {
    expect(
      droppedSubscriptionErrors(
        [item("active", "canceled"), item("canceled", "trialing")],
        (merged) => merged.sourceBooking.subscription_status === "active",
      ),
    ).toEqual([]);
  });
});
