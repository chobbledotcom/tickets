import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  mirroredMoveRefusalOrNull,
  mirrorFor,
  PAYMENT_ROW_LIFECYCLE,
  paymentWorkFor,
  paymentWorkForMirrors,
  type RowMove,
  rowWorkMirrorSql,
} from "#shared/payment/admit-move.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
import { reviewCase } from "#test-utils/payment-claim.ts";

/** What the operator is told, word for word. Pinned here because these
 *  sentences are the whole point of refusing: they have to name the thing that
 *  is in the way and what to do about it. */
const CLAIM_REFUSAL =
  "A refund for this person is still in progress. Finish or re-run the refund, then try again.";
const REVIEW_REFUSAL =
  "The owner still has to resolve a payment problem for this person. Refresh or correct the payment evidence, then try again.";
const UNRECORDED_REFUSAL =
  "This person's money went back, but the accounts do not show it. Record it, then try again.";

const CLAIMED: PaymentRowState = {
  claim: {
    attendeeIds: [7],
    commandId: "test-command",
    phase: "checking",
    scope: "attendee_set",
    writtenAt: "2026-01-01T00:00:00.000Z",
  },
};
const UNDER_REVIEW: PaymentRowState = {
  review: reviewCase({ kind: "partially_returned_obligation" }),
};
const UNRECORDED: PaymentRowState = {
  unrecorded: { returnedAt: "2026-01-01T00:00:00.000Z" },
};
const SETTLED: PaymentRowState = { outcome: { error: "Card declined" } };
const FREE: PaymentRowState = {};

const moveRefusal = (
  states: readonly PaymentRowState[],
  move: RowMove,
): string | null => mirroredMoveRefusalOrNull(states.map(mirrorFor), move);

describe("payment > admit move", () => {
  test("every row hold declares its route, owner choice, and priority", () => {
    const declarations = Object.fromEntries(
      Object.entries(PAYMENT_ROW_LIFECYCLE).map(([name, rule]) => [
        name,
        {
          operatorRoute: rule.operatorRoute,
          requiresChoice: rule.requiresChoice,
          saidFirst: rule.saidFirst,
        },
      ]),
    );
    expect(declarations).toEqual({
      claim: {
        operatorRoute: "/admin/attendees/:attendeeId/refresh-payment",
        requiresChoice: false,
        saidFirst: 0,
      },
      review: {
        operatorRoute: "/admin/attendees/:attendeeId/payment-review",
        requiresChoice: true,
        saidFirst: 1,
      },
      unrecorded: {
        operatorRoute: "/admin/attendees/:attendeeId/refresh-payment",
        requiresChoice: false,
        saidFirst: 2,
      },
    });
  });

  describe("a claim stops both writers", () => {
    const cases: RowMove[] = ["delete", "merge"];
    for (const move of cases) {
      test(`${move} is refused while a refund holds the row`, () => {
        expect(moveRefusal([CLAIMED], move)).toBe(CLAIM_REFUSAL);
      });
    }
  });

  describe("an owner review parts the two writers", () => {
    // A delete destroys the row the marker rides on, and that marker is the
    // promise someone will look at this person's money.
    test("delete waits for the owner to look at the payment", () => {
      expect(moveRefusal([UNDER_REVIEW], "delete")).toBe(REVIEW_REFUSAL);
    });

    // A merge only relocates it: the marker arrives on the merged person and
    // the review is still there to do.
    test("merge carries the review across instead of refusing", () => {
      expect(moveRefusal([UNDER_REVIEW], "merge")).toBeNull();
    });
  });

  describe("money the books have not caught up with", () => {
    // Deleting destroys the payment row, and that row is the repair target for
    // the correction somebody was just asked to make — while the payout stays
    // missing from the ledger.
    test("delete waits until the money is on the books", () => {
      expect(moveRefusal([UNRECORDED], "delete")).toBe(UNRECORDED_REFUSAL);
    });

    // A merge relocates the row, so the mark rides across and the correction
    // is still there to make afterwards.
    test("merge carries the mark across instead of refusing", () => {
      expect(moveRefusal([UNRECORDED], "merge")).toBeNull();
    });
  });

  describe("what does not hold a row up", () => {
    test("a payment that already ended stops neither writer", () => {
      expect(moveRefusal([SETTLED], "delete")).toBeNull();
      expect(moveRefusal([SETTLED], "merge")).toBeNull();
    });

    test("rows in the middle of nothing stop neither writer", () => {
      expect(moveRefusal([FREE, FREE], "delete")).toBeNull();
    });

    test("an attendee with no payment rows at all is free to go", () => {
      expect(moveRefusal([], "delete")).toBeNull();
    });
  });

  test("one busy row among free ones is enough to refuse", () => {
    // The writer takes every row it is shown, so the answer is about the worst
    // of them, not the first.
    expect(moveRefusal([FREE, FREE, CLAIMED], "delete")).toBe(CLAIM_REFUSAL);
  });

  test("money that may be moving right now is named before a pending review", () => {
    expect(moveRefusal([UNDER_REVIEW, CLAIMED], "delete")).toBe(CLAIM_REFUSAL);
  });

  test("a review still refuses a delete when no claim is live", () => {
    expect(moveRefusal([SETTLED, UNDER_REVIEW], "delete")).toBe(REVIEW_REFUSAL);
  });

  describe("the operator-facing work", () => {
    test("clear rows need no recovery action", () => {
      expect(paymentWorkFor([FREE, SETTLED])).toEqual({
        recoveryAction: null,
        status: "clear",
      });
    });

    test("every live state names its status and reachable recovery action", () => {
      expect(paymentWorkFor([UNDER_REVIEW])).toEqual({
        recoveryAction: "payment-review",
        status: "needs_review",
      });
      expect(paymentWorkFor([UNRECORDED])).toEqual({
        recoveryAction: "refresh-payment",
        status: "needs_money_record",
      });
      expect(paymentWorkFor([CLAIMED])).toEqual({
        recoveryAction: "refresh-payment",
        status: "moving",
      });
    });

    test("claim, owner review, then ledger repair is the one shared priority", () => {
      expect(paymentWorkFor([UNDER_REVIEW, UNRECORDED])).toEqual({
        recoveryAction: "payment-review",
        status: "needs_review",
      });
      expect(paymentWorkFor([UNDER_REVIEW, UNRECORDED, CLAIMED])).toEqual({
        recoveryAction: "refresh-payment",
        status: "moving",
      });
    });

    test("local work is resolved before canonical provider recovery", () => {
      expect(paymentWorkFor([UNDER_REVIEW], true)).toEqual({
        recoveryAction: "payment-review",
        status: "needs_review",
      });
      expect(paymentWorkFor([UNRECORDED], true)).toEqual({
        recoveryAction: "refresh-payment",
        status: "needs_money_record",
      });
      expect(paymentWorkFor([CLAIMED], true)).toEqual({
        recoveryAction: "refresh-payment",
        status: "moving",
      });
    });

    test("non-sensitive mirrors use that same summary and priority", () => {
      expect(paymentWorkForMirrors([""], false)).toEqual({
        recoveryAction: null,
        status: "clear",
      });
      expect(paymentWorkForMirrors([], true)).toEqual({
        recoveryAction: null,
        status: "needs_provider_recovery",
      });
      expect(paymentWorkForMirrors(["unrecorded", "review"], true)).toEqual({
        recoveryAction: "payment-review",
        status: "needs_review",
      });
      expect(paymentWorkForMirrors(["review", "claim"], true)).toEqual({
        recoveryAction: "refresh-payment",
        status: "moving",
      });
    });
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

    test("an owner review outranks ledger repair, and a claim outranks both", () => {
      expect(mirrorFor({ ...UNRECORDED, ...UNDER_REVIEW })).toBe("review");
      expect(mirrorFor({ ...CLAIMED, ...UNRECORDED })).toBe("claim");
    });

    test("a payment that already ended shows nothing", () => {
      expect(mirrorFor(SETTLED)).toBe("");
    });

    test("a row in the middle of nothing shows nothing", () => {
      expect(mirrorFor(FREE)).toBe("");
    });

    test("the SQL guard makes the same decision from those words", () => {
      expect(mirroredMoveRefusalOrNull(["review", "claim"], "delete")).toBe(
        CLAIM_REFUSAL,
      );
      expect(mirroredMoveRefusalOrNull(["unrecorded"], "merge")).toBeNull();
    });

    test("an unknown word fails loudly instead of freeing the row", () => {
      expect(() => mirroredMoveRefusalOrNull(["mystery"], "delete")).toThrow(
        "Unknown protected payment state: mystery",
      );
    });
  });

  test("the SQL work predicates render the table's own words", () => {
    expect(rowWorkMirrorSql("payment.", "claim")).toBe(
      "payment.protected_state = 'claim'",
    );
    expect(rowWorkMirrorSql("", "review")).toBe("protected_state = 'review'");
    expect(rowWorkMirrorSql("payment.", "unrecorded")).toBe(
      "payment.protected_state = 'unrecorded'",
    );
  });
});
