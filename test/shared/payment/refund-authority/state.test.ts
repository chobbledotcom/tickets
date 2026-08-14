import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  mayReplayKeyedRefund,
  readRefundAuthorityState,
  readyRefund,
  rearmKeyedRefund,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  returnRefundToReady,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";
import {
  markRefundOwnerChoiceNeeded,
  resolveRefundOwnerChoice,
} from "#shared/payment/refund-authority-choice.ts";

const keyedReady = () =>
  readyRefund({
    evidenceRevision: 4,
    nextActionAt: 110,
    now: 100,
    request: {
      capability: "keyed",
      generation: 1,
      identityIndex: "request-one",
      replayUntil: 500,
    },
  });

const keylessReady = () =>
  readyRefund({
    evidenceRevision: 4,
    nextActionAt: 110,
    now: 100,
    request: {
      capability: "keyless",
      generation: 1,
      identityIndex: "request-one",
    },
  });

describe("payment > refund authority state", () => {
  test("stores one strict tagged state", () => {
    const state = keyedReady();
    const stored = writeRefundAuthorityState(state, "test charge");

    expect(readRefundAuthorityState(stored, "test charge")).toEqual(state);
    expect(() =>
      readRefundAuthorityState(
        JSON.stringify({ ...state, surprise: true }),
        "test charge",
      ),
    ).toThrow("Invalid stored JSON");
  });

  test("a keyed generation carries its finite exact replay window", () => {
    const armed = armRefundSend(keyedReady(), 120, 150);
    const observing = markRefundObservationDue(armed, 130, 170);

    expect(mayReplayKeyedRefund(observing, "request-one", 500)).toBe(true);
    expect(mayReplayKeyedRefund(observing, "another-request", 400)).toBe(false);
    expect(mayReplayKeyedRefund(observing, "request-one", 501)).toBe(false);
    expect(rearmKeyedRefund(observing, "request-one", 400, 430)).toMatchObject({
      armedAt: 400,
      kind: "send_armed",
      request: { generation: 1, identityIndex: "request-one" },
    });
    expect(() => rearmKeyedRefund(observing, "request-one", 501, 530)).toThrow(
      "outside its replay window",
    );
  });

  test("a keyless send can never use the keyed replay transition", () => {
    const observing = markRefundObservationDue(
      armRefundSend(keylessReady(), 120, 150),
      130,
      170,
    );

    expect(mayReplayKeyedRefund(observing, "request-one", 140)).toBe(false);
    expect(() => rearmKeyedRefund(observing, "request-one", 140, 170)).toThrow(
      "keyless",
    );
  });

  test("a conclusive not-sent answer is the only automatic way back to ready", () => {
    const observing = markRefundObservationDue(
      armRefundSend(keylessReady(), 120, 150),
      130,
      170,
    );

    expect(returnRefundToReady(observing, 5, 180, 190)).toMatchObject({
      evidenceRevision: 5,
      kind: "ready",
      readyAt: 180,
      request: { generation: 1 },
    });
    expect(() => returnRefundToReady(keylessReady(), 5, 180, 190)).toThrow(
      "not armed",
    );
  });

  test("an ambiguous keyless arm ends in a required choice, never a retry", () => {
    const choice = markRefundOwnerChoiceNeeded(
      armRefundSend(keylessReady(), 120, 150),
      180,
      "possibly_sent",
    );

    expect(choice).toMatchObject({
      kind: "needs_owner_choice",
      local: { kind: "not_due" },
      reason: "possibly_sent",
    });
    expect(() =>
      markRefundOwnerChoiceNeeded(keylessReady(), 180, "provider_rejected"),
    ).toThrow("cannot start from ready");
  });

  test("each unresolved-money reason declares its allowed source states", () => {
    const keyless = armRefundSend(keylessReady(), 120, 150);
    const keyed = markRefundObservationDue(
      armRefundSend(keyedReady(), 120, 150),
      510,
      520,
    );

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
        keyedReady(),
        180,
        "provider_unreadable",
      ).reason,
    ).toBe("provider_unreadable");
    expect(
      markRefundOwnerChoiceNeeded(
        keyedReady(),
        180,
        "provider_conflict",
      ).reason,
    ).toBe("provider_conflict");
    expect(
      markRefundOwnerChoiceNeeded(keyed, 510, "replay_window_expired").reason,
    ).toBe("replay_window_expired");
    expect(() =>
      markRefundOwnerChoiceNeeded(keyless, 180, "replay_window_expired"),
    ).toThrow("reason does not match");
    expect(() =>
      markRefundOwnerChoiceNeeded(keyed, 510, "possibly_sent"),
    ).toThrow("reason does not match");
    expect(() =>
      markRefundOwnerChoiceNeeded(keyless, 180, "provider_unreadable"),
    ).toThrow("cannot start from send_armed");
    expect(() =>
      markRefundOwnerChoiceNeeded(keyedReady(), 180, "possibly_sent"),
    ).toThrow("cannot start from ready");
  });

  test("provider-returned choice makes local recording due", () => {
    const choice = markRefundOwnerChoiceNeeded(
      armRefundSend(keylessReady(), 120, 150),
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
      armRefundSend(keylessReady(), 120, 150),
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

  test("a not-sent keyed choice starts a new finite keyed generation", () => {
    const observing = markRefundObservationDue(
      armRefundSend(keyedReady(), 120, 150),
      510,
      520,
    );
    const choice = markRefundOwnerChoiceNeeded(
      observing,
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

  test("completion and local recording are separate durable facts", () => {
    const completed = markRefundCompleted(keyedReady(), 140, "provider");
    expect(completed.local).toEqual({ kind: "due", returnedAt: 140 });

    const recorded = markRefundLocalRecorded(completed, 160);
    expect(recorded.local).toEqual({
      kind: "recorded",
      recordedAt: 160,
      returnedAt: 140,
    });
    expect(() => markRefundLocalRecorded(recorded, 170)).toThrow(
      "not waiting for local recording",
    );
  });

  test("plain mirrors are always derived from the parsed state", () => {
    const ready = keyedReady();
    const completed = markRefundCompleted(ready, 140, "provider");

    expect(refundStateMirror(ready)).toBe("ready");
    expect(refundLocalMirror(completed)).toBe("due");
    expect(refundNextActionAt(ready)).toBe(110);
    expect(refundNextActionAt(completed)).toBe(140);
    expect(
      refundNextActionAt(markRefundLocalRecorded(completed, 160)),
    ).toBeNull();
  });
});
