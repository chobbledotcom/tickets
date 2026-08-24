/* jscpd:ignore-start -- imports */
import { assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import {
  sumupReadFailure,
  sumupRefundFailure,
} from "#shared/sumup/failures.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";

/* jscpd:ignore-end */

type FailedRead = ProviderRead<never>;
type FailedRefund = Extract<
  RefundAttemptResult,
  { kind: "rejected" | "uncertain" }
>;

type FailureCase = {
  error: Error;
  log: string;
  name: string;
  read: FailedRead;
  refund: FailedRefund;
};

const knownFailures: FailureCase[] = [
  {
    error: transportError.answered(providerDetail.sumup(), 404, "missing"),
    log: "[SumUp] Transaction read answered 404",
    name: "an answer that says the record is not there",
    read: { status: "missing" },
    refund: { kind: "rejected", reason: "rejected" },
  },
  {
    error: transportError.answered(providerDetail.sumup(), 429),
    log: "[SumUp] Transaction read answered 429",
    name: "an answer that says to slow down",
    read: { reason: "rate_limited", status: "unavailable" },
    refund: { kind: "uncertain", reason: "rate_limited" },
  },
  {
    error: transportError.unusable(providerDetail.sumup()),
    log: "[SumUp] Transaction read returned malformed data",
    name: "a malformed provider answer",
    read: { reason: "malformed_response", status: "invalid" },
    refund: { kind: "uncertain", reason: "malformed_response" },
  },
  {
    error: transportError.unreachable(providerDetail.sumup(), "network_error"),
    log: "[SumUp] Transaction read failed before SumUp answered",
    name: "a connection failure",
    read: { reason: "network_error", status: "unavailable" },
    refund: { kind: "uncertain", reason: "network_error" },
  },
  {
    error: transportError.unreachable(providerDetail.sumup(), "timeout"),
    log: "[SumUp] Transaction read failed before SumUp answered",
    name: "a request that ran out of time",
    read: { reason: "timeout", status: "unavailable" },
    refund: { kind: "uncertain", reason: "timeout" },
  },
];

describe("SumUp failures", () => {
  const debugSpy = useDebugLogSpy();

  for (const failure of knownFailures) {
    test(`classifies ${failure.name}`, () => {
      expect(sumupReadFailure("Transaction", failure.error)).toEqual(
        failure.read,
      );
      expect(sumupRefundFailure(failure.error)).toEqual(failure.refund);
      expect(debugMessages(debugSpy())).toEqual([failure.log]);
    });
  }

  const expectPropagated = (failure: Error): void => {
    expect(assertThrows(() => sumupReadFailure("Transaction", failure))).toBe(
      failure,
    );
    expect(assertThrows(() => sumupRefundFailure(failure))).toBe(failure);
  };

  test("does not claim an internal error", () => {
    expectPropagated(new Error("broken adapter"));
  });

  test("does not claim a raw connection failure the transport did not name", () => {
    expectPropagated(new TypeError("connection reset"));
  });

  test("does not claim another kind of DOM failure", () => {
    expectPropagated(new DOMException("broken", "DataError"));
  });
});
