import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  mirrorFor,
  moveRefusalOrNull,
  type RowMove,
} from "#shared/payment/admit-move.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";

/** What the operator is told, word for word. Pinned here because these
 *  sentences are the whole point of refusing: they have to name the thing that
 *  is in the way and what to do about it. */
const CLAIM_REFUSAL =
  "A refund for this person is still in progress. Finish or re-run the refund, then try again.";
const REVIEW_REFUSAL =
  "The owner still has to check a payment for this person. Mark it reviewed, then try again.";
const UNRECORDED_REFUSAL =
  "This person's money went back, but the accounts do not show it. Record it, then try again.";

const CLAIMED: PaymentRowState = {
  claim: {
    attendeeIds: [7],
    capability: "keyless",
    commandId: "test-command",
    phase: "send_armed",
    scope: "attendee_set",
    writtenAt: "2026-01-01T00:00:00.000Z",
  },
};
const UNDER_REVIEW: PaymentRowState = { review: { kind: "partial_refund" } };
const UNRECORDED: PaymentRowState = {
  unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" },
};
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

  describe("money the books have not caught up with", () => {
    // Deleting destroys the payment row, and that row is the repair target for
    // the correction somebody was just asked to make — while the payout stays
    // missing from the ledger.
    test("delete waits until the money is on the books", () => {
      expect(moveRefusalOrNull([UNRECORDED], "delete")).toBe(
        UNRECORDED_REFUSAL,
      );
    });

    // A merge relocates the row, so the mark rides across and the correction
    // is still there to make afterwards.
    test("merge carries the mark across instead of refusing", () => {
      expect(moveRefusalOrNull([UNRECORDED], "merge")).toBeNull();
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

  describe("the word the consumers that cannot decrypt see", () => {
    test("a claimed row shows its claim", () => {
      expect(mirrorFor(CLAIMED)).toBe("claim");
    });

    test("a row waiting on the owner shows its review", () => {
      // The prune and the orphan purge read only this word, so a review that
      // does not show here is a row they will happily destroy.
      expect(mirrorFor(UNDER_REVIEW)).toBe("review");
    });

    test("a row whose money is off the books shows that", () => {
      // Same reason as the review: this word is the whole of what the prune
      // and the orphan purge can see.
      expect(mirrorFor(UNRECORDED)).toBe("unrecorded");
    });

    test("a claim outranks a review while both are on the row", () => {
      expect(mirrorFor({ ...CLAIMED, ...UNDER_REVIEW })).toBe("claim");
    });

    test("money off the books outranks a review, and a claim outranks both", () => {
      expect(mirrorFor({ ...UNRECORDED, ...UNDER_REVIEW })).toBe("unrecorded");
      expect(mirrorFor({ ...CLAIMED, ...UNRECORDED })).toBe("claim");
    });

    test("a payment that already ended shows nothing", () => {
      expect(mirrorFor(SETTLED)).toBe("");
    });

    test("a row in the middle of nothing shows nothing", () => {
      expect(mirrorFor(FREE)).toBe("");
    });
  });
});
