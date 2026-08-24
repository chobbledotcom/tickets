import * as v from "valibot";
/* jscpd:ignore-start -- imports */
import {
  type ProviderFailure,
  providerFailure,
} from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import type { RefundProof } from "#payment/refund-attempt.ts";
import { transportFactsOf } from "#payment/transport-error.ts";

/* jscpd:ignore-end */

/** A schema failure is Square's answer not matching its documented shape,
 * which the transport cannot see because the parse happens above it. */
const squareFailure = (error: unknown): ProviderFailure | undefined =>
  providerFailure(
    transportFactsOf(error) ??
      (error instanceof v.ValiError ? { malformed: true } : {}),
  );

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
