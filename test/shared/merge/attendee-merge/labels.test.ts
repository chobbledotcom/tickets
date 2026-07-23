/** Label behavior for the split attendee merge service test suite. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingConflictLabel,
  bookingKey,
  hasBookingConflicts,
  nonConflictAnswerLabel,
} from "#shared/merge/attendee-merge.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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
      expect(bookingConflictLabel({ conflictClass: "duplicate" })).toBe(
        "Duplicate",
      );
    });

    test("returns Conflicting metadata for conflicting_metadata class", () => {
      expect(
        bookingConflictLabel({ conflictClass: "conflicting_metadata" }),
      ).toBe("Conflicting metadata");
    });
  });

  describe("hasBookingConflicts", () => {
    test("returns false when all items are moveable", () => {
      expect([
        hasBookingConflicts([]),
        hasBookingConflicts([
          { conflictClass: "moveable" },
          { conflictClass: "moveable" },
        ]),
      ]).toEqual([false, false]);
    });

    test("returns true for either non-moveable conflict class", () => {
      expect([
        hasBookingConflicts([
          { conflictClass: "moveable" },
          { conflictClass: "duplicate" },
        ]),
        hasBookingConflicts([{ conflictClass: "conflicting_metadata" }]),
      ]).toEqual([true, true]);
    });
  });
});
