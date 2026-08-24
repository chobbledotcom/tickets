/* jscpd:ignore-start -- imports */
import { requireProviderFailure } from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import { transportFactsOf } from "#payment/transport-error.ts";
import { logDebug } from "#shared/logger.ts";
/* jscpd:ignore-end */

/** The immediate answer to a SumUp refund call. Its empty success body only
 * proves that the request was sent; a fresh transaction read must decide
 * whether SumUp has accepted or completed it. */
export type SumupRefundSubmission =
  | { kind: "sent" }
  | Extract<
      RefundAttemptResult,
      { kind: "not_sent" | "rejected" | "uncertain" }
    >;

/** Turn a known provider failure into the read it proves. */
export const sumupReadFailure = <Resource>(
  resourceName: string,
  err: unknown,
): ProviderRead<Resource> => {
  const outcome = requireProviderFailure(err);
  const facts = transportFactsOf(err);
  const statusCode = facts?.statusCode;
  logDebug(
    "SumUp",
    statusCode === undefined
      ? facts?.malformed !== true
        ? `${resourceName} read failed before SumUp answered`
        : `${resourceName} read returned malformed data`
      : `${resourceName} read answered ${statusCode}`,
  );
  return outcome.read;
};

/** A failed send either proves SumUp refused it or leaves the answer unknown. */
export const sumupRefundFailure = (err: unknown): SumupRefundSubmission =>
  requireProviderFailure(err).refund;
