import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundObservationDue,
} from "#shared/payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
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
    expect(
      markRefundOwnerChoiceNeeded(keyed, 180, "provider_conflict").reason,
    ).toBe("provider_conflict");
    expect(
      markRefundOwnerChoiceNeeded(
        readyRefundForTest("keyed"),
        180,
        "provider_unreadable",
      ).reason,
    ).toBe("provider_unreadable");
    expect(
      markRefundOwnerChoiceNeeded(
        readyRefundForTest("keyed"),
        180,
        "provider_conflict",
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

  test("provider-returned choice makes local recording due", () => {
    const choice = markRefundOwnerChoiceNeeded(
      keylessArmed(),
      180,
      "possibly_sent",
    );
    const completed = resolveRefundOwnerChoice(choice, {
      decidedAt: 200,
      kind: "provider_confirms_returned",
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
      kind: "provider_confirms_not_sent",
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
        kind: "provider_confirms_not_sent",
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
      kind: "provider_confirms_not_sent",
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
});
