import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { claimRequestFor } from "#db/payment-claim/scope.ts";
import type { LoadedRefundAttendee } from "#db/payment-claim/take.ts";

/** An attendee whose loaded references carry these matching indexes. */
const attendee = (
  attendeeId: number,
  ...matchingIndexes: string[]
): LoadedRefundAttendee =>
  ({
    attendeeId,
    references: matchingIndexes.map((index) => ({ matchingIndexes: [index] })),
  }) as unknown as LoadedRefundAttendee;

const row = { referenceIndex: "idx-1", sessionId: "cs_1" };

describe("claimRequestFor", () => {
  test("names the attendee whose reference matches the row", () => {
    expect(claimRequestFor([attendee(7, "idx-1")], row)).toEqual({
      attendeeIds: [7],
      scope: "attendee_set",
    });
  });

  test("leaves out an attendee no reference of whose matches", () => {
    expect(
      claimRequestFor([attendee(7, "idx-1"), attendee(9, "idx-other")], row),
    ).toEqual({ attendeeIds: [7], scope: "attendee_set" });
  });

  test("names an attendee once, whatever how many references match", () => {
    expect(
      claimRequestFor([attendee(7, "idx-1", "idx-1")], row).attendeeIds,
    ).toEqual([7]);
  });

  test("names every matching attendee, smallest id first", () => {
    expect(
      claimRequestFor(
        [attendee(9, "idx-1"), attendee(2, "idx-1"), attendee(5, "idx-1")],
        row,
      ).attendeeIds,
    ).toEqual([2, 5, 9]);
  });

  test("matches on any one of an attendee's references", () => {
    expect(
      claimRequestFor([attendee(7, "idx-other", "idx-1")], row).attendeeIds,
    ).toEqual([7]);
  });

  // A payment row always belongs to somebody. Nothing matching means the row
  // and the loaded attendees disagree, which is a bug rather than an answer.
  test("refuses a row that matches no attendee at all", () => {
    expect(() => claimRequestFor([attendee(7, "idx-other")], row)).toThrow(
      "Payment row matched no initiating attendee",
    );
  });

  test("refuses a row when there are no attendees to match", () => {
    expect(() => claimRequestFor([], row)).toThrow(
      "Payment row matched no initiating attendee",
    );
  });
});
