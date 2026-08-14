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
  refundAuthorityWorkSql,
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
      expect(lifecycle.refusal).toBe(
        "A provider refund for this payment is still in progress. Open Refund recovery and finish it, then try again.",
      );
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
      refusal:
        "The provider returned this money, but the local accounts do not show it. Record it in Refund recovery, then try again.",
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
    const providerCheck = markRefundProviderConflict(ready(), 40, {
      captured: { amount: 2_500, currency: "GBP" },
      kind: "returned",
      refunded: { amount: 400, currency: "GBP" },
    });

    expect(
      refundMoveRefusalOrNull(
        [ready(), providerCheck, ownerChoice, completed],
        "delete",
      ),
    ).toBe(refundLifecycleFor(completed).refusal);
    expect(
      refundMoveRefusalOrNull([providerCheck, ownerChoice], "delete"),
    ).toBe(refundLifecycleFor(ownerChoice).refusal);
    expect(refundMoveRefusalOrNull([ready()], "merge")).toBeNull();
    expect(refundMoveRefusalOrNull([recorded], "delete")).toBeNull();
  });

  test("provider-check recovery rejects an inconsistent state", () => {
    let kindReads = 0;
    const inconsistent = new Proxy(ready(), {
      get: (target, property, receiver) => {
        if (property === "kind") {
          kindReads += 1;
          return kindReads === 1 ? "needs_provider_check" : "ready";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => refundLifecycleFor(inconsistent)).toThrow(
      "Provider-check recovery received another refund state",
    );
  });

  test("the SQL guard is derived from every blocking stored state", () => {
    expect(refundAuthorityWorkSql("charge.")).toBe(
      "((charge.refund_state_name = 'completed' AND charge.refund_local_state = 'due') OR " +
        "charge.refund_state_name = 'needs_owner_choice' OR " +
        "charge.refund_state_name = 'needs_provider_check' OR " +
        "charge.refund_state_name = 'observing' OR " +
        "charge.refund_state_name = 'ready' OR " +
        "charge.refund_state_name = 'send_armed')",
    );
  });
});
