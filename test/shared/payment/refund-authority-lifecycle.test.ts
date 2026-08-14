import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
} from "#shared/payment/refund-authority-choice.ts";
import {
  refundLifecycleFor,
  refundMoveRefusalOrNull,
} from "#shared/payment/refund-authority-lifecycle.ts";

const ready = () =>
  readyRefund({
    evidenceRevision: 1,
    nextActionAt: 10,
    now: 1,
    request: {
      capability: "keyless",
      generation: 1,
      identityIndex: "request-one",
    },
  });

describe("payment > declared refund authority lifecycle", () => {
  test("unfinished work blocks deletion but can move with its indexed row", () => {
    const armed = armRefundSend(ready(), 2, 20);
    const observing = markRefundObservationDue(armed, 3, 30);

    for (const state of [ready(), armed, observing]) {
      const lifecycle = refundLifecycleFor(state);
      expect(lifecycle.blocks.delete).toBe(true);
      expect(lifecycle.blocks.merge).toBe(false);
      expect(lifecycle.prunable).toBe(false);
      expect(lifecycle.requiresChoice).toBe(false);
      expect(lifecycle.clearedBy).toBe("requestProviderRefund");
      expect(lifecycle.operatorRoute).toBe("/admin/privacy/refunds/:id");
    }
  });

  test("ambiguous money names the required owner exit", () => {
    const state = markRefundOwnerChoiceNeeded(
      armRefundSend(ready(), 2, 20),
      40,
      "possibly_sent",
    );

    expect(refundLifecycleFor(state)).toEqual({
      blocks: { delete: true, merge: false },
      clearedBy: "resolveProviderRefundCase",
      operatorRoute: "/admin/privacy/refunds/:id",
      prunable: false,
      refusal:
        "The owner still has to decide what happened to a provider refund. Resolve it in Refund recovery, then try again.",
      requiresChoice: true,
    });
  });

  test("partial money names provider recheck as its only safe exit", () => {
    const state = markRefundProviderConflict(ready(), 40, {
      captured: { amount: 2_500, currency: "GBP" },
      kind: "returned",
      refunded: { amount: 400, currency: "GBP" },
    });
    expect(state.kind).toBe("needs_provider_check");

    expect(refundLifecycleFor(state)).toEqual({
      blocks: { delete: true, merge: false },
      clearedBy: "requestProviderRefund",
      operatorRoute: "/admin/privacy/refunds/:id",
      prunable: false,
      refusal:
        "The provider shows only part of this payment returned. Check it again in Refund recovery, then try again.",
      requiresChoice: false,
    });
  });

  test("inconclusive evidence names provider recheck as its only exit", () => {
    const state = markRefundProviderConflict(ready(), 40, {
      captured: { amount: 2_500, currency: "GBP" },
      kind: "wait",
      refunded: { amount: 400, currency: "GBP" },
    });
    expect(state.kind).toBe("needs_provider_check");

    expect(refundLifecycleFor(state)).toMatchObject({
      clearedBy: "requestProviderRefund",
      refusal:
        "The provider evidence is not conclusive yet. Check it again in Refund recovery, then try again.",
      requiresChoice: false,
    });
  });

  test("returned money stays protected until local books are recorded", () => {
    const completed = markRefundCompleted(ready(), 40, "provider");
    expect(refundLifecycleFor(completed)).toMatchObject({
      blocks: { delete: true, merge: false },
      clearedBy: "markRefundAuthorityRecorded",
      prunable: false,
    });

    expect(
      refundLifecycleFor(markRefundLocalRecorded(completed, 50)),
    ).toMatchObject({
      blocks: { delete: false, merge: false },
      prunable: true,
    });
  });

  test("the most urgent blocking state supplies one move refusal", () => {
    const ownerChoice = markRefundOwnerChoiceNeeded(
      armRefundSend(ready(), 2, 20),
      40,
      "possibly_sent",
    );
    const completed = markRefundCompleted(ready(), 40, "provider");
    const recorded = markRefundLocalRecorded(completed, 50);

    expect(
      refundMoveRefusalOrNull([ready(), ownerChoice, completed], "delete"),
    ).toBe(refundLifecycleFor(completed).refusal);
    expect(refundMoveRefusalOrNull([ready()], "merge")).toBeNull();
    expect(refundMoveRefusalOrNull([recorded], "delete")).toBeNull();
  });
});
