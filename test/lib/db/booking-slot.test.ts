import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingSlotKey,
  hasDuplicateBookingSlot,
} from "#shared/db/attendees/booking-slot.ts";

describe("db > attendees > booking-slot", () => {
  describe("bookingSlotKey", () => {
    test("produces stable key for listing + date", () => {
      expect(bookingSlotKey(1, "2026-07-01")).toBe("1|2026-07-01|0");
    });

    test("uses empty string for null date", () => {
      expect(bookingSlotKey(1, null)).toBe("1||0");
    });

    test("uses empty string for undefined date", () => {
      expect(bookingSlotKey(1, undefined)).toBe("1||0");
    });

    test("includes parentListingId when non-zero", () => {
      expect(bookingSlotKey(7, "2026-07-01", 42)).toBe("7|2026-07-01|42");
    });

    test("same child under different parents produces distinct keys", () => {
      const a = bookingSlotKey(7, "2026-07-01", 10);
      const b = bookingSlotKey(7, "2026-07-01", 20);
      expect(a).not.toBe(b);
    });
  });

  describe("hasDuplicateBookingSlot", () => {
    test("empty list is not a duplicate", () => {
      expect(hasDuplicateBookingSlot([])).toBe(false);
    });

    test("single line is not a duplicate", () => {
      expect(
        hasDuplicateBookingSlot([{ date: "2026-07-01", listingId: 1 }]),
      ).toBe(false);
    });

    test("two lines with different listing ids are not duplicates", () => {
      expect(
        hasDuplicateBookingSlot([
          { date: "2026-07-01", listingId: 1 },
          { date: "2026-07-01", listingId: 2 },
        ]),
      ).toBe(false);
    });

    test("two lines with the same listing id and date are duplicates", () => {
      expect(
        hasDuplicateBookingSlot([
          { date: "2026-07-01", listingId: 1 },
          { date: "2026-07-01", listingId: 1 },
        ]),
      ).toBe(true);
    });

    test("same child under different parents (multi-parent) is NOT a duplicate", () => {
      // The widened slot index (listing_id, attendee_id, start_at, parent_listing_id)
      // allows one row per (child, parent) pair — these must not collide.
      expect(
        hasDuplicateBookingSlot([
          { date: "2026-07-01", listingId: 7, parentListingId: 10 },
          { date: "2026-07-01", listingId: 7, parentListingId: 20 },
        ]),
      ).toBe(false);
    });

    test("two identical (child, date, parent) lines ARE duplicates", () => {
      // The same (child, date, parent) triple would still collide on the index.
      expect(
        hasDuplicateBookingSlot([
          { date: "2026-07-01", listingId: 7, parentListingId: 10 },
          { date: "2026-07-01", listingId: 7, parentListingId: 10 },
        ]),
      ).toBe(true);
    });

    test("undefined parentListingId is treated as 0", () => {
      // Two lines with undefined parentListingId collide (both treated as 0).
      expect(
        hasDuplicateBookingSlot([
          { date: "2026-07-01", listingId: 7 },
          { date: "2026-07-01", listingId: 7 },
        ]),
      ).toBe(true);
    });

    test("explicit parentListingId 0 and undefined are the same slot", () => {
      // undefined and 0 both normalise to 0 in the key — same slot, still a duplicate.
      const undefinedParent: number | undefined = undefined;
      expect(
        hasDuplicateBookingSlot([
          {
            date: "2026-07-01",
            listingId: 7,
            ...(undefinedParent !== undefined
              ? { parentListingId: undefinedParent }
              : {}),
          },
          { date: "2026-07-01", listingId: 7, parentListingId: 0 },
        ]),
      ).toBe(true);
    });
  });
});
