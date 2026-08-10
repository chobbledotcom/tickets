import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { moveRefusalOrNull, type RowMove } from "#shared/payment/admit-move.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";

/** What the operator is told, word for word. Pinned here because these
 *  sentences are the whole point of refusing: they have to name the thing that
 *  is in the way and what to do about it. */
const CLAIM_REFUSAL =
  "A refund for this person is still in progress. Finish or re-run the refund, then try again.";
const REVIEW_REFUSAL =
  "The owner still has to check a payment for this person. Mark it reviewed, then try again.";

const CLAIMED: PaymentRowState = {
  claim: {
    attendeeId: 7,
    capability: "keyless",
    scope: "attendee_set",
    writtenAt: "2026-01-01T00:00:00.000Z",
  },
};
const UNDER_REVIEW: PaymentRowState = { review: { kind: "partial_refund" } };
const SETTLED: PaymentRowState = { outcome: { error: "Card declined" } };
const FREE: PaymentRowState = {};

describe("payment > admit move", () => {
  describe("a claim stops both writers", () => {
    const cases: RowMove[] = ["delete", "merge"];
    for (const move of cases) {
      test(`${move} is refused while a refund holds the row`, () => {
        expect(moveRefusalOrNull([CLAIMED], move)).toBe(CLAIM_REFUSAL);
      });
    }
  });

  describe("an owner review parts the two writers", () => {
    // A delete destroys the row the marker rides on, and that marker is the
    // promise someone will look at this person's money.
    test("delete waits for the owner to look at the payment", () => {
      expect(moveRefusalOrNull([UNDER_REVIEW], "delete")).toBe(REVIEW_REFUSAL);
    });

    // A merge only relocates it: the marker arrives on the merged person and
    // the review is still there to do.
    test("merge carries the review across instead of refusing", () => {
      expect(moveRefusalOrNull([UNDER_REVIEW], "merge")).toBeNull();
    });
  });

  describe("what does not hold a row up", () => {
    test("a payment that already ended stops neither writer", () => {
      expect(moveRefusalOrNull([SETTLED], "delete")).toBeNull();
      expect(moveRefusalOrNull([SETTLED], "merge")).toBeNull();
    });

    test("rows in the middle of nothing stop neither writer", () => {
      expect(moveRefusalOrNull([FREE, FREE], "delete")).toBeNull();
    });

    test("an attendee with no payment rows at all is free to go", () => {
      expect(moveRefusalOrNull([], "delete")).toBeNull();
    });
  });

  test("one busy row among free ones is enough to refuse", () => {
    // The writer takes every row it is shown, so the answer is about the worst
    // of them, not the first.
    expect(moveRefusalOrNull([FREE, FREE, CLAIMED], "delete")).toBe(
      CLAIM_REFUSAL,
    );
  });

  test("money that may be moving right now is named before a pending review", () => {
    expect(moveRefusalOrNull([UNDER_REVIEW, CLAIMED], "delete")).toBe(
      CLAIM_REFUSAL,
    );
  });

  test("a review still refuses a delete when no claim is live", () => {
    expect(moveRefusalOrNull([SETTLED, UNDER_REVIEW], "delete")).toBe(
      REVIEW_REFUSAL,
    );
  });
});
