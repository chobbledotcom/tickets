/** The pure row transitions, pinned one by one: who may settle, what each
 * settlement changes, what every change preserves, and the fence that keeps
 * a terminal outcome off live work. The row machine spec sweeps these same
 * functions across every stored shape; this file pins the fine grain. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { openPaymentReview } from "#shared/payment/review.ts";
import type { PaymentRowState } from "#shared/payment/row-state.ts";
import {
  checkingClaimFor,
  claimHeldBy,
  grantClaim,
  type PaymentRowSettlement,
  settledRowState,
  withOutcome,
} from "#shared/payment/row-transitions.ts";

const COMMAND = "row-transitions-command";
const HELD_SINCE = "2026-08-16T10:00:00.000Z";
const RETURNED_AT = "2026-08-16T11:00:00.000Z";
const HELD = { commandId: COMMAND, heldSince: HELD_SINCE };

const CLAIM = checkingClaimFor(
  { attendeeIds: [4, 7], scope: "attendee_set" },
  COMMAND,
  HELD_SINCE,
);

const claimed = (rest: Omit<PaymentRowState, "claim"> = {}): PaymentRowState =>
  grantClaim(rest, CLAIM);

const release: PaymentRowSettlement = { claim: "release", phase: "checking" };

describe("payment > row transitions", () => {
  test("the checking fence copies the attendee set and stamps its identity", () => {
    expect(CLAIM).toEqual({
      attendeeIds: [4, 7],
      commandId: COMMAND,
      phase: "checking",
      scope: "attendee_set",
      writtenAt: HELD_SINCE,
    });
  });

  test("claimHeldBy accepts only the exact hold", () => {
    const held = { ...HELD, phase: "checking" as const };
    expect(claimHeldBy(CLAIM, held)).toBe(true);
    expect(claimHeldBy(undefined, held)).toBe(false);
    expect(claimHeldBy(CLAIM, { ...held, commandId: "other" })).toBe(false);
    expect(claimHeldBy(CLAIM, { ...held, heldSince: RETURNED_AT })).toBe(false);
  });

  test("granting overwrites an admitted stale fence in place", () => {
    const stale = { ...CLAIM, commandId: "stale-run" };
    expect(grantClaim({ claim: stale }, CLAIM)).toEqual({ claim: CLAIM });
  });

  test("a settlement that does not hold the row settles nothing", () => {
    expect(settledRowState({}, release, HELD, RETURNED_AT)).toBeNull();
    expect(
      settledRowState(
        claimed(),
        release,
        { ...HELD, commandId: "other" },
        RETURNED_AT,
      ),
    ).toBeNull();
    expect(
      settledRowState(
        claimed(),
        release,
        { ...HELD, heldSince: RETURNED_AT },
        RETURNED_AT,
      ),
    ).toBeNull();
  });

  test("a plain release keeps everything else on the row", () => {
    const review = openPaymentReview({ kind: "shared_reference" });
    const state = claimed({ review, unrecorded: { returnedAt: RETURNED_AT } });
    expect(settledRowState(state, release, HELD, "ignored")).toEqual({
      review,
      unrecorded: { returnedAt: RETURNED_AT },
    });
  });

  test("recording the money takes the books-behind word off", () => {
    const state = claimed({ unrecorded: { returnedAt: RETURNED_AT } });
    expect(
      settledRowState(state, { ...release, books: "recorded" }, HELD, "x"),
    ).toEqual({});
  });

  test("finding unrecorded money keeps the date the first mark stored", () => {
    const first = settledRowState(
      claimed(),
      { ...release, books: "unrecorded" },
      HELD,
      RETURNED_AT,
    );
    expect(first).toEqual({ unrecorded: { returnedAt: RETURNED_AT } });
    const again = settledRowState(
      grantClaim(first!, CLAIM),
      { ...release, books: "unrecorded" },
      HELD,
      "2026-08-16T12:00:00.000Z",
    );
    expect(again).toEqual({ unrecorded: { returnedAt: RETURNED_AT } });
  });

  test("resolving a review the row does not hold keeps the one it does", () => {
    const review = openPaymentReview({
      kind: "partially_returned_obligation",
    });
    const state = claimed({ review });
    expect(
      settledRowState(
        state,
        {
          ...release,
          review: { kind: "resolved", reason: "shared_reference" },
        },
        HELD,
        "x",
      ),
    ).toEqual({ review });
  });

  test("resolving the review the row holds takes it off", () => {
    const review = openPaymentReview({ kind: "shared_reference" });
    expect(
      settledRowState(
        claimed({ review }),
        {
          ...release,
          review: { kind: "resolved", reason: "shared_reference" },
        },
        HELD,
        "x",
      ),
    ).toEqual({});
  });

  test("re-opening the same reason keeps the case the owner already saw", () => {
    const seen = {
      ...openPaymentReview({ kind: "shared_reference" }),
      acknowledgedAt: RETURNED_AT,
    };
    expect(
      settledRowState(
        claimed({ review: seen }),
        {
          ...release,
          review: { kind: "review", reason: { kind: "shared_reference" } },
        },
        HELD,
        "x",
      ),
    ).toEqual({ review: seen });
  });

  test("a different reason replaces the case with a fresh unseen one", () => {
    const old = openPaymentReview({ kind: "shared_reference" });
    const settled = settledRowState(
      claimed({ review: old }),
      {
        ...release,
        review: {
          kind: "review",
          reason: { kind: "partially_returned_obligation" },
        },
      },
      HELD,
      "x",
    );
    expect(settled?.review?.reason.kind).toBe("partially_returned_obligation");
    expect(settled?.review?.caseId).not.toBe(old.caseId);
    expect(settled?.review?.acknowledgedAt).toBeUndefined();
  });

  test("a terminal outcome lands only on a slot with no live work", () => {
    expect(withOutcome({}, { error: "Card declined" })).toEqual({
      outcome: { error: "Card declined" },
    });
    expect(
      withOutcome({ outcome: { error: "old" } }, { error: "new" }),
    ).toEqual({ outcome: { error: "new" } });
    for (const live of [
      claimed(),
      { review: openPaymentReview({ kind: "shared_reference" }) },
      { unrecorded: { returnedAt: RETURNED_AT } },
    ]) {
      expect(() => withOutcome(live, { error: "x" })).toThrow(
        "A terminal outcome cannot land on live payment work",
      );
    }
  });
});
