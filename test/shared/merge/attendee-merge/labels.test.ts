import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingConflictLabel,
  bookingKey,
  hasBookingConflicts,
  nonConflictAnswerLabel,
} from "#shared/merge/attendee-merge.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("attendee merge service", { db: true }, () => {
  describe("bookingKey", () => {
    test("formats key with start_at", () => {
      expect(bookingKey(1, "2026-05-01", 0, 0)).toBe("1:2026-05-01:0:0");
    });

    test("formats key with null start_at", () => {
      expect(bookingKey(1, null, 0, 0)).toBe("1:null:0:0");
    });

    test("distinguishes rows by parent_listing_id", () => {
      expect(bookingKey(5, null, 1, 0)).toBe("5:null:1:0");
      expect(bookingKey(5, null, 2, 0)).toBe("5:null:2:0");
    });

    test("distinguishes rows by package_group_id", () => {
      expect(bookingKey(5, null, 0, 3)).toBe("5:null:0:3");
      expect(bookingKey(5, null, 0, 4)).toBe("5:null:0:4");
    });
  });

  describe("nonConflictAnswerLabel", () => {
    test("returns target label when target has answer", () => {
      const item = {
        conflict: false,
        questionId: 1,
        questionText: "Q?",
        sourceAnswerId: null,
        sourceAnswerText: null,
        targetAnswerId: 10,
        targetAnswerText: "Red",
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Red",
        from: "target",
      });
    });

    test("returns source label when only source has answer", () => {
      const item = {
        conflict: false,
        questionId: 1,
        questionText: "Q?",
        sourceAnswerId: 20,
        sourceAnswerText: "Water",
        targetAnswerId: null,
        targetAnswerText: null,
      };
      expect(nonConflictAnswerLabel(item)).toEqual({
        answer: "Water",
        from: "source",
      });
    });
  });

  describe("bookingConflictLabel", () => {
    test("returns Duplicate for duplicate conflict class", () => {
      const item = {
        conflictClass: "duplicate" as const,
        listingId: 1,
        sourceBooking:
          {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
        startAt: null,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Duplicate");
    });

    test("returns Conflicting metadata for conflicting_metadata class", () => {
      const item = {
        conflictClass: "conflicting_metadata" as const,
        listingId: 1,
        sourceBooking:
          {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
        startAt: null,
        targetBooking: null,
      };
      expect(bookingConflictLabel(item)).toBe("Conflicting metadata");
    });
  });

  describe("hasBookingConflicts", () => {
    test("returns false when all items are moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          listingId: 1,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(false);
    });

    test("returns true when at least one item is not moveable", () => {
      const items = [
        {
          conflictClass: "moveable" as const,
          listingId: 1,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
        {
          conflictClass: "duplicate" as const,
          listingId: 2,
          sourceBooking:
            {} as import("#shared/db/attendee-types.ts").ListingAttendeeRow,
          startAt: null,
          targetBooking: null,
        },
      ];
      expect(hasBookingConflicts(items)).toBe(true);
    });
  });
});
