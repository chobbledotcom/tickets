import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  buildTicketListing,
  parentAndChildFitGroup,
  ticketsThatFitInPool,
} from "#booking/model.ts";
import { listing } from "#test-utils/booking-model-fixtures.ts";
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

    test("daily listings ignore attendee headcount entirely, even at a full house", () => {
      // max_attendees/attendee_count would say sold out for a standard
      // listing, but a daily listing's own capacity is unlimited (each day
      // is its own booking) — max_quantity is the only real cap here.
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
      expect(tl.maxPurchasable).toBe(100);
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

    test("closed listings have zero purchasable even with stock", () => {
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
    });
  });
});
