/* jscpd:ignore-start -- imports */
import {
  type ProviderFailure,
  providerFailureOf,
} from "#payment/provider-failures.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import {
  providerResourceReader,
  type ResourceReader,
} from "#payment/provider-resource-read.ts";
import type { RefundProof } from "#payment/refund-attempt.ts";
/* jscpd:ignore-end */

/** Translate a known Square read failure, leaving internal bugs unclaimed. */
export const squareReadFailure = (
  error: unknown,
): ProviderRead<never> | undefined => providerFailureOf(error)?.read;

/** Translate a known Square refund failure, leaving internal bugs unclaimed. */
export const squareRefundFailure = (
  error: unknown,
): ProviderFailure["refund"] | undefined => providerFailureOf(error)?.refund;

/** Read one Square resource. Every Square read resolves its client the same
 * way and reads a failed call the same way, so each one says only what it
 * asks for and how it judges the answer. */
export const readSquareResource = <Client>(
  getClient: () => Promise<Client | null>,
): ResourceReader<Client> =>
  providerResourceReader(getClient, squareReadFailure);

/** Turn Square's named refund into the provider-neutral proof. */
export const namedSquareRefund = (refund: {
  id: string;
  paymentId: string;
}): RefundProof => ({
  kind: "named_refund",
  refund: {
    id: refund.id,
    kind: "square_refund",
    parentId: refund.paymentId,
    provider: "square",
  },
});
