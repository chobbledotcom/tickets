import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  mayReplayKeyedRefund,
  readRefundAuthorityState,
  rearmKeyedRefund,
  refundLocalMirror,
  refundNextActionAt,
  refundStateMirror,
  returnRefundToReady,
  writeRefundAuthorityState,
} from "#shared/payment/refund-authority.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";

describe("payment > refund authority state", () => {
  test("stores one strict tagged state", () => {
    const state = readyRefundForTest("keyed");
    const stored = writeRefundAuthorityState(state, "test charge");

    expect(readRefundAuthorityState(stored, "test charge")).toEqual(state);
    expect(() =>
      readRefundAuthorityState(
        JSON.stringify({ ...state, surprise: true }),
        "test charge",
      )
    ).toThrow("Invalid stored JSON");
  });

  test("a keyed generation carries its finite exact replay window", () => {
    const armed = armRefundSend(readyRefundForTest("keyed"), 120, 150);
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
      armRefundSend(readyRefundForTest("keyless"), 120, 150),
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
      armRefundSend(readyRefundForTest("keyless"), 120, 150),
      130,
      170,
    );

    expect(returnRefundToReady(observing, 5, 180, 190)).toMatchObject({
      evidenceRevision: 5,
      kind: "ready",
      readyAt: 180,
      request: { generation: 1 },
    });
    expect(() =>
      returnRefundToReady(readyRefundForTest("keyless"), 5, 180, 190)
    ).toThrow(
      "not armed",
    );
  });

  test("completion and local recording are separate durable facts", () => {
    const completed = markRefundCompleted(
      readyRefundForTest("keyed"),
      140,
      "provider",
    );
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
    const ready = readyRefundForTest("keyed");
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
