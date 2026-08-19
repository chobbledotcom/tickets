import { APIError } from "@sumup/sdk";
import {
  type ProviderFailure,
  type ProviderFailureFacts,
  providerFailure,
} from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundAttemptResult } from "#payment/refund-attempt.ts";
import { logDebug } from "#shared/logger.ts";
import { isAbortOrTimeoutError } from "#shared/named-error.ts";
import { SumupApiError, SumupProtocolError } from "#shared/sumup/transport.ts";

/** The immediate answer to a SumUp refund call. Its empty success body only
 * proves that the request was sent; a fresh transaction read must decide
 * whether SumUp has accepted or completed it. */
export type SumupRefundSubmission =
  | { kind: "sent" }
  | Extract<
      RefundAttemptResult,
      { kind: "not_sent" | "rejected" | "uncertain" }
    >;

const sumupFailureFacts = (err: unknown): ProviderFailureFacts | undefined => {
  if (err instanceof APIError) return { statusCode: err.status };
  if (err instanceof SumupApiError) return { statusCode: err.statusCode };
  if (err instanceof SumupProtocolError) return { malformed: true };
  if (err instanceof TypeError) return { connectionReason: "network_error" };
  if (isAbortOrTimeoutError(err)) {
    return { connectionReason: "timeout" };
  }
  return;
};

const knownSumupFailure = (
  err: unknown,
): { facts: ProviderFailureFacts; outcome: ProviderFailure } => {
  const facts = sumupFailureFacts(err);
  if (facts === undefined) throw err;
  const outcome = providerFailure(facts);
  if (outcome === undefined) throw err;
  return { facts, outcome };
};

/** Turn a known provider failure into the read it proves. */
export const sumupReadFailure = <Resource>(
  resourceName: string,
  err: unknown,
): ProviderRead<Resource> => {
  const { facts, outcome } = knownSumupFailure(err);
  const statusCode = facts.statusCode;
  logDebug(
    "SumUp",
    statusCode === undefined
      ? facts.malformed
        ? `${resourceName} read returned malformed data`
        : `${resourceName} read failed before SumUp answered`
      : `${resourceName} read answered ${statusCode}`,
  );
  return outcome.read;
};

/** A failed send either proves SumUp refused it or leaves the answer unknown. */
export const sumupRefundFailure = (err: unknown): SumupRefundSubmission =>
  knownSumupFailure(err).outcome.refund;
