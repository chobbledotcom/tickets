import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  readyRefund,
} from "#shared/payment/refund-authority.ts";
import { markRefundOwnerChoiceNeeded } from "#shared/payment/refund-authority-choice.ts";
import { refundLifecycleFor } from "#shared/payment/refund-authority-lifecycle.ts";

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

describe("payment > refund authority lifecycle", () => {
  test("every unfinished automatic state blocks destructive actions", () => {
    const armed = armRefundSend(ready(), 2, 20);
    const observing = markRefundObservationDue(armed, 3, 30);

    for (const state of [ready(), armed, observing]) {
      const lifecycle = refundLifecycleFor(state);
      expect(lifecycle.blocks.delete).toBe(true);
      expect(lifecycle.blocks.merge).toBe(true);
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
      blocks: { delete: true, merge: true },
      clearedBy: "resolveProviderRefundCase",
      operatorRoute: "/admin/privacy/refunds/:id",
      prunable: false,
      refusal:
        "The owner still has to decide what happened to a provider refund. Resolve it in Refund recovery, then try again.",
      requiresChoice: true,
    });
  });

  test("returned money stays protected until local books are recorded", () => {
    const completed = markRefundCompleted(ready(), 40, "provider");
    expect(refundLifecycleFor(completed)).toMatchObject({
      blocks: { delete: true, merge: true },
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
});
