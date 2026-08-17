import * as v from "valibot";
/* jscpd:ignore-start -- imports */
import {
  type ProviderFailure,
  providerFailure,
} from "#shared/payment/provider-failures.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import type { RefundProof } from "#shared/payment/refund-attempt.ts";
import {
  SquareApiError,
  SquareConnectionError,
  SquareProtocolError,
} from "#shared/square/transport.ts";

/* jscpd:ignore-end */

const squareFailure = (error: unknown): ProviderFailure | undefined =>
  providerFailure({
    connectionReason:
      error instanceof SquareConnectionError ? error.reason : undefined,
    malformed:
      error instanceof SquareProtocolError || error instanceof v.ValiError,
    statusCode: error instanceof SquareApiError ? error.statusCode : undefined,
  });

/** Translate a known Square read failure, leaving internal bugs unclaimed. */
export const squareReadFailure = (
  error: unknown,
): ProviderRead<never> | undefined => squareFailure(error)?.read;

/** Translate a known Square refund failure, leaving internal bugs unclaimed. */
export const squareRefundFailure = (
  error: unknown,
): ProviderFailure["refund"] | undefined => squareFailure(error)?.refund;

/** Turn Square's named refund into the provider-neutral proof. */
export const namedSquareRefund = (refund: {
  id: string;
  payment_id: string;
}): RefundProof => ({
  kind: "named_refund",
  refund: {
    id: refund.id,
    kind: "square_refund",
    parentId: refund.payment_id,
    provider: "square",
  },
});
