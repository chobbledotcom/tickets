/* jscpd:ignore-start -- imports */
import { assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { APIError } from "@sumup/sdk";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import {
  sumupReadFailure,
  sumupRefundFailure,
} from "#shared/sumup/failures.ts";
import { SumupApiError, SumupProtocolError } from "#shared/sumup/transport.ts";
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
    error: new APIError(404, "missing", new Response()),
    log: "[SumUp] Transaction read answered 404",
    name: "an SDK HTTP answer",
    read: { status: "missing" },
    refund: { kind: "rejected", reason: "rejected" },
  },
  {
    error: new SumupApiError(429),
    log: "[SumUp] Transaction read answered 429",
    name: "a transport HTTP answer",
    read: { reason: "rate_limited", status: "unavailable" },
    refund: { kind: "uncertain", reason: "rate_limited" },
  },
  {
    error: new SumupProtocolError("broken JSON"),
    log: "[SumUp] Transaction read returned malformed data",
    name: "a malformed provider answer",
    read: { reason: "malformed_response", status: "invalid" },
    refund: { kind: "uncertain", reason: "malformed_response" },
  },
  {
    error: new TypeError("connection reset"),
    log: "[SumUp] Transaction read failed before SumUp answered",
    name: "a connection failure",
    read: { reason: "network_error", status: "unavailable" },
    refund: { kind: "uncertain", reason: "network_error" },
  },
  {
    error: new DOMException("cancelled", "AbortError"),
    log: "[SumUp] Transaction read failed before SumUp answered",
    name: "an aborted request",
    read: { reason: "timeout", status: "unavailable" },
    refund: { kind: "uncertain", reason: "timeout" },
  },
  {
    error: new DOMException("late", "TimeoutError"),
    log: "[SumUp] Transaction read failed before SumUp answered",
    name: "a timed-out request",
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

  test("does not claim an HTTP error with no status", () => {
    const failure = new APIError(500, "missing status", new Response());
    Object.defineProperty(failure, "status", { value: undefined });
    expectPropagated(failure);
  });

  test("does not claim another kind of DOM failure", () => {
    expectPropagated(new DOMException("broken", "DataError"));
  });
});
