import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { validateAttendeeMergeDecision } from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
  AttendeeMergeDiffAnswerItem,
  AttendeeMergeDiffBookingItem,
} from "#shared/merge/attendee-merge-types.ts";
import { describeWithEnv } from "#test-utils";

/** A listing-attendee booking row on listing 5, overridable per test. */
const row = (over: Partial<ListingAttendeeRow> = {}): ListingAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  ledger_event_group: "",
  listing_id: 5,
  order_token: "",
  package_group_id: 0,
  parent_listing_id: 0,
  price_paid: 0,
  quantity: 1,
  refunded: 0,
  start_at: null,
  ...over,
});

/** A same-listing booking conflict item, overridable per test. */
const bookingItem = (
  over: Partial<AttendeeMergeDiffBookingItem> = {},
): AttendeeMergeDiffBookingItem => ({
  conflictClass: "duplicate",
  listingId: 5,
  packageGroupId: 0,
  parentListingId: 0,
  sourceBooking: row(),
  sourceSaleAmount: 0,
  startAt: null,
  targetBooking: row(),
  targetSaleAmount: 0,
  ...over,
});

/** A diff between source #2 and target #1 with no changes, overridable. */
const diffWith = (
  over: Partial<AttendeeMergeDiff> = {},
): AttendeeMergeDiff => ({
  answerItems: [],
  bookingItems: [],
  piiFields: [],
  sourceId: 2,
  targetId: 1,
  version: "v1",
  ...over,
});

/** A diff whose only change is one booking conflict. */
const oneBookingDiff = (
  item: AttendeeMergeDiffBookingItem,
): AttendeeMergeDiff => diffWith({ bookingItems: [item] });

/** A decision that accepts everything (matching `diffWith`'s version). */
const decision = (
  over: Partial<AttendeeMergeDecisionInput> = {},
): AttendeeMergeDecisionInput => ({
  answers: {},
  bookings: {},
  money: {},
  pii: {},
  version: "v1",
  ...over,
});

/** A conflicting answer on question 10 (target Red vs source Blue). */
const colourConflict: AttendeeMergeDiffAnswerItem = {
  conflict: true,
  questionId: 10,
  questionText: "Colour?",
  sourceAnswerId: 2,
  sourceAnswerText: "Blue",
  targetAnswerId: 1,
  targetAnswerText: "Red",
};

/** Assert a validation failed and one of its errors mentions `substring`. */
const expectInvalidContaining = (
  result: ReturnType<typeof validateAttendeeMergeDecision>,
  substring: string,
) => {
  expect(result.valid).toBe(false);
  if (!result.valid) {
    expect(result.errors.some((e) => e.includes(substring))).toBe(true);
  }
};

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("validateAttendeeMergeDecision", () => {
    test("rejects stale version", () => {
      const result = validateAttendeeMergeDecision(
        diffWith(),
        decision({ version: "v2" }),
      );
      expectInvalidContaining(result, "out of date");
    });

    test("rejects missing answer decision for conflict", () => {
      const result = validateAttendeeMergeDecision(
        diffWith({ answerItems: [colourConflict] }),
        decision(),
      );
      expectInvalidContaining(result, "Colour?");
    });

    test("rejects missing booking decision for conflict", () => {
      const result = validateAttendeeMergeDecision(
        oneBookingDiff(
          bookingItem({
            conflictClass: "conflicting_metadata",
            targetBooking: row({ quantity: 2 }),
          }),
        ),
        decision(),
      );
      expectInvalidContaining(result, "Listing #5");
    });

    test("rejects missing booking decision for daily listing conflict", () => {
      const startAt = "2026-06-15T10:00:00Z";
      const result = validateAttendeeMergeDecision(
        oneBookingDiff(
          bookingItem({
            listingId: 7,
            sourceBooking: row({ listing_id: 7, start_at: startAt }),
            startAt,
            targetBooking: row({
              listing_id: 7,
              quantity: 2,
              start_at: startAt,
            }),
          }),
        ),
        decision(),
      );
      expectInvalidContaining(result, "2026-06-15");
    });

    test("rejects copying a no-quantity source line that still carries a payment", () => {
      // A quantity-0 line must have price_paid = 0; merging one that doesn't
      // would strand the charge behind the quantity-0 refund guards.
      const result = validateAttendeeMergeDecision(
        oneBookingDiff(
          bookingItem({
            conflictClass: "moveable",
            sourceBooking: row({ price_paid: 1500, quantity: 0 }),
            sourceSaleAmount: 1500,
            targetBooking: null,
          }),
        ),
        decision(),
      );
      expectInvalidContaining(result, "strand a recorded payment");
    });

    test("rejects replacing an active paid target line with a no-quantity source", () => {
      // take_source would delete the paid target and insert the quantity-0
      // source, stranding the target's payment behind a ghost row.
      const result = validateAttendeeMergeDecision(
        oneBookingDiff(
          bookingItem({
            conflictClass: "conflicting_metadata",
            sourceBooking: row({ quantity: 0 }),
            targetBooking: row({ price_paid: 1500, quantity: 2 }),
            targetSaleAmount: 1500,
          }),
        ),
        decision({ bookings: { "5:null:0:0": "take_source" } }),
      );
      expectInvalidContaining(result, "strand a recorded payment");
    });

    test("allows moving a no-quantity source line that carries no payment", () => {
      // A clean quantity-0 sentinel (no payment, no paid target) is moveable.
      const result = validateAttendeeMergeDecision(
        oneBookingDiff(
          bookingItem({
            conflictClass: "moveable",
            sourceBooking: row({ quantity: 0 }),
            targetBooking: null,
          }),
        ),
        decision(),
      );
      expect(result.valid).toBe(true);
    });

    test("accepts valid decisions", () => {
      const result = validateAttendeeMergeDecision(
        diffWith({
          answerItems: [colourConflict],
          bookingItems: [bookingItem({ targetBooking: row({ quantity: 2 }) })],
        }),
        decision({
          answers: { "10": "source" },
          bookings: { "5:null:0:0": "keep_target" },
          pii: { name: "target" },
        }),
      );
      expect(result.valid).toBe(true);
    });

    // --- Decision 17: a discarded booking that carries money needs a choice --- //

    /** A single same-listing duplicate conflict carrying the given ledger sale
     *  amounts on each side. */
    const moneyConflictDiff = (
      sourceSaleAmount: number,
      targetSaleAmount: number,
    ): AttendeeMergeDiff =>
      oneBookingDiff(
        bookingItem({
          sourceBooking: row({ ledger_event_group: "grp", price_paid: 5000 }),
          sourceSaleAmount,
          targetBooking: row({ ledger_event_group: "grp", price_paid: 5000 }),
          targetSaleAmount,
        }),
      );

    const moneyDecision = (
      money: AttendeeMergeDecisionInput["money"],
      booking: "keep_target" | "take_source" = "keep_target",
    ): AttendeeMergeDecisionInput =>
      decision({ bookings: { "5:null:0:0": booking }, money });

    test("rejects a discarded paid booking with no money decision", () => {
      // keep_target discards the SOURCE booking (£50 of recognised sale), so the
      // operator must choose credit vs write-off — never a silent default.
      const result = validateAttendeeMergeDecision(
        moneyConflictDiff(5000, 5000),
        moneyDecision({}),
      );
      expectInvalidContaining(result, "money decision");
    });

    test("accepts a discarded paid booking once a money choice is given", () => {
      const result = validateAttendeeMergeDecision(
        moneyConflictDiff(5000, 5000),
        moneyDecision({ "5:null:0:0": "credit" }),
      );
      expect(result.valid).toBe(true);
    });

    test("needs no money decision when the discarded booking is free", () => {
      // A £0 conflict carries no money, so only the row choice is required.
      const result = validateAttendeeMergeDecision(
        moneyConflictDiff(0, 0),
        moneyDecision({}),
      );
      expect(result.valid).toBe(true);
    });

    test("take_source weighs the TARGET amount it discards, not the source", () => {
      // Replacing with the source discards the TARGET booking; its £50 is what
      // needs a decision even though the source booking is free.
      const result = validateAttendeeMergeDecision(
        moneyConflictDiff(0, 5000),
        moneyDecision({}, "take_source"),
      );
      expectInvalidContaining(result, "money decision");
    });
  });
});
