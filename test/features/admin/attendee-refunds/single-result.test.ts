import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { singleRefundResultError } from "#routes/admin/attendee-refunds/single-result.ts";
import type { RefundBatchResult } from "#routes/admin/refunds/provider.ts";
import type { PaymentWorkStatus } from "#shared/payment/admit-move.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";

const ATTENDEE_ID = 42;
const ACTIONS_URL = `/admin/attendees/${ATTENDEE_ID}/actions`;
const REFUND_URL = `/admin/attendees/${ATTENDEE_ID}/refund`;

const requireResponse = (response: Response | null): Response => {
  if (response === null) throw new Error("The refund result had no error page");
  return response;
};

const counts = (
  changed: Partial<Extract<RefundBatchResult, { kind: "finished" }>["counts"]>,
): Extract<RefundBatchResult, { kind: "finished" }> => ({
  counts: {
    failedCount: 0,
    notRecordedCount: 0,
    pendingCount: 0,
    refundedCount: 0,
    ...changed,
  },
  kind: "finished",
});

type ErrorResultCase = {
  readonly message: string;
  readonly name: string;
  readonly result: RefundBatchResult;
  readonly status: PaymentWorkStatus;
  readonly url: string;
};

const ERROR_RESULTS: readonly ErrorResultCase[] = [
  {
    message:
      "A refund for this payment is still settling. Refresh payment status after it completes.",
    name: "a run blocked by another claim",
    result: { kind: "blocked", reason: "refund_in_progress" },
    status: "moving",
    url: ACTIONS_URL,
  },
  {
    message: "Provider evidence changed",
    name: "a readiness refusal",
    result: {
      counts: counts({ failedCount: 1 }).counts,
      kind: "not_ready",
      message: "Provider evidence changed",
    },
    status: "clear",
    url: REFUND_URL,
  },
  {
    message:
      "The payment provider sent the refund. It could not be recorded in Money. Fix Money, then refresh payment status. Do not send the refund again.",
    name: "money that has not been recorded",
    result: counts({ notRecordedCount: 1 }),
    status: "needs_money_record",
    url: ACTIONS_URL,
  },
  {
    message:
      "A refund for this payment is still settling. Refresh payment status after it completes.",
    name: "a provider-accepted refund",
    result: counts({ pendingCount: 1 }),
    status: "moving",
    url: ACTIONS_URL,
  },
  {
    message: "Refund failed. The payment may have already been refunded.",
    name: "an ordinary failed send",
    result: counts({ failedCount: 1 }),
    status: "clear",
    url: REFUND_URL,
  },
];

describe("single refund result", () => {
  for (const { message, name, result, status, url } of ERROR_RESULTS) {
    test(`sends ${name} to its safe page`, async () => {
      const response = await singleRefundResultError(
        result,
        ATTENDEE_ID,
        "",
        () => Promise.resolve(status),
      );
      expect(response).not.toBeNull();
      expectRedirectWithFlash(url, message, false)(requireResponse(response));
    });
  }

  test("honours an Actions return URL", async () => {
    const response = await singleRefundResultError(
      { kind: "blocked", reason: "refund_in_progress" },
      ATTENDEE_ID,
      ACTIONS_URL,
    );
    expectRedirectWithFlash(
      ACTIONS_URL,
      "A refund for this payment is still settling. Refresh payment status after it completes.",
      false,
    )(requireResponse(response));
  });

  test("needs no error page after one complete refund", async () => {
    const response = await singleRefundResultError(
      counts({ refundedCount: 1 }),
      ATTENDEE_ID,
      "",
      () => {
        throw new Error("A successful refund re-read the work state");
      },
    );
    expect(response).toBeNull();
  });
});
