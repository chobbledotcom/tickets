import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  armRefundSend,
  markRefundCompleted,
  markRefundLocalRecorded,
  markRefundObservationDue,
  readyRefund,
  rearmKeyedRefund,
  returnRefundToReady,
} from "#shared/payment/refund-authority.ts";
import { readyRefundForTest } from "#test-utils/refund-authority.ts";

describe("payment > refund authority transitions", () => {
  test("sent-only transitions reject a ready refund", () => {
    const ready = readyRefundForTest("keyed");

    expect(() => markRefundObservationDue(ready, 120, 150)).toThrow(
      "Refund is not armed for observation",
    );
    expect(() => rearmKeyedRefund(ready, "request-one", 120, 150)).toThrow(
      "Refund is not armed for a keyed replay",
    );
  });

  test("a keyed generation carries its finite exact replay window", () => {
    const armed = armRefundSend(readyRefundForTest("keyed"), 120, 150);
    const observing = markRefundObservationDue(armed, 130, 170);

    expect(rearmKeyedRefund(observing, "request-one", 400, 430)).toMatchObject({
      armedAt: 400,
      kind: "send_armed",
      request: { generation: 1, identityIndex: "request-one" },
    });
    expect(() =>
      rearmKeyedRefund(observing, "another-request", 400, 430),
    ).toThrow("only its exact request");
    expect(() => rearmKeyedRefund(observing, "request-one", 501, 530)).toThrow(
      "outside its replay window",
    );
    expect(() =>
      readyRefund({
        evidenceRevision: 1,
        nextActionAt: 500,
        now: 501,
        request: {
          capability: "keyed",
          generation: 1,
          identityIndex: "expired-before-start",
          replayUntil: 500,
        },
      }),
    ).toThrow("cannot start outside its replay window");
  });

  test("a keyless send can never use the keyed replay transition", () => {
    const observing = markRefundObservationDue(
      armRefundSend(readyRefundForTest("keyless"), 120, 150),
      130,
      170,
    );

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
      returnRefundToReady(readyRefundForTest("keyless"), 5, 180, 190),
    ).toThrow("not armed");
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
    expect(() => markRefundCompleted(completed, 170, "provider")).toThrow(
      "already completed",
    );
    expect(() => armRefundSend(completed, 170, 180)).toThrow(
      "not ready to arm",
    );
  });
});
