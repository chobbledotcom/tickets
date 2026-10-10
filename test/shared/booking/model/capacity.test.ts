import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildTicketListing,
  parentAndChildFitGroup,
  quantityBelowMin,
  ticketsThatFitInPool,
} from "#booking/model.ts";
import { dailyOverrides, listing } from "#test-utils/booking-model-fixtures.ts";
import { useSetting } from "#test-utils/settings.ts";

describe("booking model — capacity", () => {
  useSetting({ timezone: "UTC" });

  describe("parentAndChildFitGroup", () => {
    test("fits when both cap and remaining are undefined (uncapped)", () => {
      expect(
        parentAndChildFitGroup({ remaining: undefined, staticCap: undefined }),
      ).toBe(true);
    });

    test("fits exactly at the parent+child unit count", () => {
      expect(
        parentAndChildFitGroup({ remaining: undefined, staticCap: 2 }),
      ).toBe(true);
      expect(
        parentAndChildFitGroup({ remaining: 2, staticCap: undefined }),
      ).toBe(true);
    });

    test("does not fit one below the parent+child unit count", () => {
      expect(
        parentAndChildFitGroup({ remaining: undefined, staticCap: 1 }),
      ).toBe(false);
      expect(
        parentAndChildFitGroup({ remaining: 1, staticCap: undefined }),
      ).toBe(false);
    });

    test("both constraints must pass", () => {
      expect(parentAndChildFitGroup({ remaining: 1, staticCap: 5 })).toBe(
        false,
      );
      expect(parentAndChildFitGroup({ remaining: 5, staticCap: 1 })).toBe(
        false,
      );
    });
  });

  describe("ticketsThatFitInPool", () => {
    test("divides remaining spots evenly", () => {
      expect(ticketsThatFitInPool(10, 2)).toBe(5);
    });

    test("rounds down when it doesn't divide evenly", () => {
      expect(ticketsThatFitInPool(7, 2)).toBe(3);
    });

    test("returns zero when nothing fits", () => {
      expect(ticketsThatFitInPool(1, 2)).toBe(0);
    });
  });

  describe("buildTicketListing", () => {
    test("standard listing capacity is max_attendees minus attendee_count", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 3,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 100,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(7);
    });

    test("daily listings have unlimited seat capacity of their own", () => {
      const tl = buildTicketListing(
        listing({ listing_type: "daily", max_quantity: 5 }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(5);
    });

    test("a daily listing cannot advertise more places than max_attendees before a date is chosen", () => {
      // The per-date booked count is unknown until a date is picked, but
      // max_attendees bounds every date, so it still caps the ceiling here.
      const tl = buildTicketListing(
        listing(
          dailyOverrides({
            max_attendees: 2,
            max_quantity: 5,
            min_quantity: 3,
          }),
        ),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(true);
      expect(tl.maxPurchasable).toBe(0);
    });

    test("daily listings ignore attendee headcount but keep the static max_attendees cap", () => {
      // attendee_count is per-date and unknown before a date is chosen, so a
      // full house date-lessly means nothing — but max_attendees bounds every
      // date, so it still caps the ceiling (max_quantity on top of it).
      const tl = buildTicketListing(
        listing({
          attendee_count: 5,
          listing_type: "daily",
          max_attendees: 5,
          max_quantity: 100,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(5);
    });

    test("a daily listing still sells out when its shared group pool is empty", () => {
      // The per-date own cap doesn't apply date-lessly, but the group pool does.
      const tl = buildTicketListing(
        listing({ listing_type: "daily", max_quantity: 5 }),
        false,
        0,
      );
      expect(tl.isSoldOut).toBe(true);
      expect(tl.maxPurchasable).toBe(0);
    });

    test("sold out when remaining spots are zero", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 10,
          listing_type: "standard",
          max_attendees: 10,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(true);
      expect(tl.maxPurchasable).toBe(0);
    });

    test("group cap takes the minimum of the listing's own remaining and the shared group's remaining", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
        }),
        false,
        3,
      );
      expect(tl.maxPurchasable).toBe(3);
    });

    test("closed listings have zero purchasable even with stock, at any minimum", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
        }),
        true,
        undefined,
      );
      expect(tl.isClosed).toBe(true);
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(0);
      // A minimum above the stock cannot make a closed listing sell.
      const withMinimum = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
          min_quantity: 3,
        }),
        true,
        undefined,
      );
      expect(withMinimum.isClosed).toBe(true);
      expect(withMinimum.isSoldOut).toBe(false);
      expect(withMinimum.maxPurchasable).toBe(0);
    });

    test("sold out when remaining spots sit below the minimum", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 9,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
          min_quantity: 3,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(true);
      expect(tl.maxPurchasable).toBe(0);
    });

    test("allows exactly the minimum when remaining spots meet it", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 8,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
          min_quantity: 2,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(2);
    });

    test("clamps maxPurchasable to remaining spots above the minimum", () => {
      const tl = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
          min_quantity: 3,
        }),
        false,
        undefined,
      );
      expect(tl.maxPurchasable).toBe(10);
    });

    test("sold out when the shared group pool dips below the minimum", () => {
      // The listing's own remaining is 10, but the group pool clamps it to 2.
      const tl = buildTicketListing(
        listing({
          attendee_count: 0,
          listing_type: "standard",
          max_attendees: 10,
          max_quantity: 10,
          min_quantity: 3,
        }),
        false,
        2,
      );
      expect(tl.isSoldOut).toBe(true);
      expect(tl.maxPurchasable).toBe(0);
    });

    test("daily listings keep their max_quantity cap with no date-less own count", () => {
      // Remaining is Infinity before a date is chosen, so the minimum never
      // binds — max_quantity is the only ceiling.
      const tl = buildTicketListing(
        listing({
          listing_type: "daily",
          max_quantity: 5,
          min_quantity: 3,
        }),
        false,
        undefined,
      );
      expect(tl.isSoldOut).toBe(false);
      expect(tl.maxPurchasable).toBe(5);
    });
  });

  describe("quantityBelowMin", () => {
    test("zero is never below the minimum", () => {
      expect(quantityBelowMin(0, 3)).toBe(false);
    });

    test("one is below any higher minimum", () => {
      expect(quantityBelowMin(1, 2)).toBe(true);
    });

    test("any count above zero but below the minimum is refused", () => {
      expect(quantityBelowMin(2, 3)).toBe(true);
    });

    test("the minimum itself is allowed", () => {
      expect(quantityBelowMin(3, 3)).toBe(false);
    });

    test("counts above the minimum are allowed", () => {
      expect(quantityBelowMin(5, 3)).toBe(false);
    });

    test("minimum 1 allows every positive count", () => {
      expect(quantityBelowMin(0, 1)).toBe(false);
    });
  });
});
