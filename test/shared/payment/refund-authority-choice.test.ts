import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundObservationDue,
} from "#shared/payment/refund-authority.ts";
import { validateRefundAuthorityState } from "#shared/payment/refund-authority-state.ts";
import {
  markRefundOwnerChoiceNeeded,
  markRefundProviderConflict,
  refundOwnerChoices,
  resolveRefundOwnerChoice,
} from "#shared/payment/refund-authority-choice.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";

const keylessArmed = () =>
  armRefundSend(readyRefundForTest("keyless"), 120, 150);

const keyedObserving = () =>
  markRefundObservationDue(
    armRefundSend(readyRefundForTest("keyed"), 120, 150),
    510,
    520,
  );

const notSentConflict = {
  captured: { amount: 2_000, currency: "GBP" as const },
  kind: "not_sent" as const,
  refunded: { amount: 0, currency: "GBP" as const },
};

describe("payment > refund authority owner choice", () => {
  test("an ambiguous keyless arm ends in a required choice, never a retry", () => {
    const choice = markRefundOwnerChoiceNeeded(
      keylessArmed(),
      180,
      "possibly_sent",
    );

    expect(choice).toMatchObject({
      kind: "needs_owner_choice",
      local: { kind: "not_due" },
      reason: "possibly_sent",
    });
    expect(() =>
      markRefundOwnerChoiceNeeded(
        readyRefundForTest("keyless"),
        180,
        "provider_rejected",
      )
    ).toThrow("cannot start from ready");
  });

  test("each unresolved-money reason declares its allowed source states", () => {
    const keyless = keylessArmed();
    const keyed = keyedObserving();

    expect(
      markRefundOwnerChoiceNeeded(keyless, 180, "possibly_sent").reason,
    ).toBe("possibly_sent");
    expect(
      markRefundOwnerChoiceNeeded(keyless, 180, "provider_rejected").reason,
    ).toBe("provider_rejected");
    expect(markRefundProviderConflict(keyed, 180, notSentConflict).reason).toBe(
      "provider_conflict",
    );
    expect(
      markRefundOwnerChoiceNeeded(
        readyRefundForTest("keyed"),
        180,
        "provider_unreadable",
      ).reason,
    ).toBe("provider_unreadable");
    expect(
      markRefundProviderConflict(
        readyRefundForTest("keyed"),
        180,
        notSentConflict,
      ).reason,
    ).toBe("provider_conflict");
    expect(
      markRefundOwnerChoiceNeeded(keyed, 510, "replay_window_expired").reason,
    ).toBe("replay_window_expired");
    expect(() =>
      markRefundOwnerChoiceNeeded(keyless, 180, "replay_window_expired")
    ).toThrow("reason does not match");
    expect(() => markRefundOwnerChoiceNeeded(keyed, 510, "possibly_sent"))
      .toThrow("reason does not match");
    expect(() =>
      markRefundOwnerChoiceNeeded(keyless, 180, "provider_unreadable")
    ).toThrow("cannot start from send_armed");
    expect(() =>
      markRefundOwnerChoiceNeeded(
        readyRefundForTest("keyed"),
        180,
        "possibly_sent",
      )
    ).toThrow("cannot start from ready");
  });

  test("fresh provider conflict replaces only ordinary owner work", () => {
    const completed = markRefundCompleted(
      readyRefundForTest("keyless"),
      170,
      "provider",
    );
    const ordinaryChoice = markRefundOwnerChoiceNeeded(
      keylessArmed(),
      180,
      "possibly_sent",
    );
    const conclusiveChoice = markRefundProviderConflict(
      keylessArmed(),
      180,
      notSentConflict,
    );

    expect(() => markRefundProviderConflict(completed, 190, notSentConflict))
      .toThrow("Provider conflict cannot start from completed");
    expect(() =>
      markRefundProviderConflict(conclusiveChoice, 190, notSentConflict)
    ).toThrow("Provider conflict cannot start from needs_owner_choice");
    expect(
      markRefundProviderConflict(ordinaryChoice, 190, {
        captured: { amount: 2_000, currency: "GBP" },
        kind: "returned",
        refunded: { amount: 500, currency: "GBP" },
      }),
    ).toMatchObject({
      decision: { kind: "returned" },
      kind: "needs_provider_check",
    });
  });

  test("provider-returned choice makes local recording due", () => {
    const choice = markRefundOwnerChoiceNeeded(
      keylessArmed(),
      180,
      "possibly_sent",
    );
    const completed = resolveRefundOwnerChoice(choice, {
      decidedAt: 200,
      kind: "provider_confirmed_returned",
    });

    expect(completed).toMatchObject({
      completedAt: 200,
      kind: "completed",
      local: { kind: "due", returnedAt: 200 },
      proof: "owner",
    });
  });

  test("provider-not-sent choice authorizes exactly one new keyless generation", () => {
    const choice = markRefundOwnerChoiceNeeded(
      keylessArmed(),
      180,
      "possibly_sent",
    );
    const ready = resolveRefundOwnerChoice(choice, {
      capability: "keyless",
      decidedAt: 200,
      evidenceRevision: 7,
      kind: "provider_confirmed_not_sent",
      nextActionAt: 210,
      requestIndex: "request-two",
    });

    expect(ready).toMatchObject({
      evidenceRevision: 7,
      kind: "ready",
      request: {
        capability: "keyless",
        generation: 2,
        identityIndex: "request-two",
      },
    });
  });

  test("a new generation cannot change the provider's send capability", () => {
    const choice = markRefundOwnerChoiceNeeded(
      keylessArmed(),
      180,
      "possibly_sent",
    );

    expect(() =>
      resolveRefundOwnerChoice(choice, {
        capability: "keyed",
        decidedAt: 200,
        evidenceRevision: 7,
        kind: "provider_confirmed_not_sent",
        nextActionAt: 210,
        replayUntil: 500,
        requestIndex: "request-two",
      })
    ).toThrow("Owner choice must keep the provider capability");
  });

  test("a not-sent keyed choice starts a new finite keyed generation", () => {
    const choice = markRefundOwnerChoiceNeeded(
      keyedObserving(),
      510,
      "replay_window_expired",
    );
    const ready = resolveRefundOwnerChoice(choice, {
      capability: "keyed",
      decidedAt: 520,
      evidenceRevision: 8,
      kind: "provider_confirmed_not_sent",
      nextActionAt: 530,
      replayUntil: 900,
      requestIndex: "request-two",
    });

    expect(ready).toMatchObject({
      kind: "ready",
      request: {
        capability: "keyed",
        generation: 2,
        identityIndex: "request-two",
        replayUntil: 900,
      },
    });
  });

  test("provider conflicts separate real choices from provider checks", () => {
    const notSent = markRefundProviderConflict(
      keylessArmed(),
      180,
      notSentConflict,
    );
    const partial = markRefundProviderConflict(keylessArmed(), 180, {
      captured: { amount: 2_000, currency: "GBP" },
      kind: "returned",
      refunded: { amount: 500, currency: "GBP" },
    });
    const returned = markRefundProviderConflict(keylessArmed(), 180, {
      captured: { amount: 2_000, currency: "GBP" },
      kind: "returned",
      refunded: { amount: 2_000, currency: "GBP" },
    });
    const waiting = markRefundProviderConflict(keylessArmed(), 180, {
      captured: { amount: 2_000, currency: "GBP" },
      kind: "wait",
      refunded: { amount: 0, currency: "GBP" },
    });

    if (
      notSent.kind !== "needs_owner_choice" ||
      returned.kind !== "needs_owner_choice"
    ) {
      throw new Error(
        "Conclusive conflict evidence must require an owner choice",
      );
    }
    expect(refundOwnerChoices(notSent)).toEqual([
      "provider_confirmed_not_sent",
    ]);
    expect(refundOwnerChoices(returned)).toEqual([
      "provider_confirmed_returned",
    ]);
    expect(partial.kind).toBe("needs_provider_check");
    expect(waiting.kind).toBe("needs_provider_check");
    expect(() =>
      validateRefundAuthorityState({
        ...partial,
        kind: "needs_owner_choice",
      })
    ).toThrow("owner-choice conflict must admit an owner decision");
    expect(() =>
      validateRefundAuthorityState({
        ...notSent,
        kind: "needs_provider_check",
      })
    ).toThrow("provider-check state must carry evidence");
  });
});
