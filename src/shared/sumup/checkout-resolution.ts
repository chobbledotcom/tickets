/**
 * Asking SumUp what became of one checkout we staged, and turning its answer
 * into a session the payment engine can settle.
 *
 * This lives beside the rest of the SumUp domain rather than inside the
 * provider adapter because two callers need it and only one of them is the
 * provider: the webhook arrives with the id its callback named, and the
 * recovery task arrives with the id off a staged row nothing has answered
 * for. They are the same question, so they run the same code.
 */

import {
  getSealedSumupCheckout,
  openSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { logDebug } from "#shared/logger.ts";
import {
  isSessionRejection,
  type SessionRejection,
  validatedPaymentSession,
} from "#shared/payment/validated-session.ts";
import { toCanonicalIso } from "#shared/payment-helpers.ts";
import type {
  PaymentStatus,
  SessionMetadata,
  ValidatedPaymentSession,
  WebhookSessionResult,
} from "#shared/payments.ts";
import type { SumupCheckoutReading } from "#shared/sumup/recovery.ts";
import { sumupApi } from "#shared/sumup.ts";
import type {
  SumupCheckout,
  SumupCheckoutStatus,
} from "#shared/sumup-observation.ts";

/** Map SumUp's checkout lifecycle to the provider-agnostic payment status.
 * FAILED (declined) and EXPIRED are terminal — the redirect handler shows the
 * cancel page for those instead of a "contact support" error. */
export const toSumupPaymentStatus = (
  status: SumupCheckoutStatus,
): PaymentStatus =>
  status === "PAID" ? "paid" : status === "PENDING" ? "unpaid" : "failed";

/** No real SumUp checkout id is blank or anywhere near this long, so an id
 * outside the bound is refused before it costs even a database lookup — and
 * on the same fixed path as every other refusal, so the payload is never
 * echoed into a log and a forger learns nothing from the answer's shape. */
const MAX_SUMUP_ID_BYTES = 255;

const isUsableSumupId = (id: string): boolean =>
  id !== "" && new TextEncoder().encode(id).byteLength <= MAX_SUMUP_ID_BYTES;

/** Refuse a callback retryably with a value-free console line. Forged and
 * unreadable callbacks must not spend alert subrequests, and the fixed words
 * carry the outcome without carrying any value from the payload. */
const refuseRetryably = (why: string): "retry" => {
  logDebug("Webhook", `SumUp callback refused retryably: ${why}`);
  return "retry";
};

/** Build a validated session from a fetched checkout and its staged metadata.
 * The metadata was written by our own buildItemsMetadata, so it always carries
 * the required fields. Returns a rejection when the checkout's charge or
 * resource id is malformed (the boundary validates both), so a paid charge the
 * boundary cannot read still reaches the refund path. */
export const buildSumupSession = (
  checkout: SumupCheckout,
  metadata: Record<string, string>,
): ValidatedPaymentSession | SessionRejection =>
  validatedPaymentSession({
    amountTotal: checkout.amountMinor,
    createdAt: toCanonicalIso(checkout.createdAt),
    currency: checkout.currency,
    id: checkout.reference,
    metadata: metadata as SessionMetadata,
    paymentReference: checkout.transactionId,
    paymentStatus: toSumupPaymentStatus(checkout.status),
    provider: "sumup",
  });

/** What SumUp said about a checkout, and the session that came of it. The
 * webhook only wants the session; the recovery task needs SumUp's own word
 * too, because "we could not read it" and "it was never paid" move a staged
 * row to very different places. */
export type SumupCheckoutResolution = {
  readonly reading: SumupCheckoutReading;
  readonly resolved: WebhookSessionResult;
};

/** A read that told us nothing usable — never to be read as "not paid". */
const unusable = (why: string): SumupCheckoutResolution => ({
  reading: "unusable",
  resolved: refuseRetryably(why),
});

/**
 * Ask SumUp what became of one checkout we staged, and turn its answer into a
 * session the payment engine can settle.
 *
 * The webhook reaches this with the id its callback named; the recovery task
 * reaches it with the id off a staged row that nothing has answered for. They
 * are the same question, so they run the same code — the recovery task is not
 * a second way of reading SumUp.
 */
export const resolveSumupCheckoutById = async (
  sumupId: string,
): Promise<SumupCheckoutResolution> => {
  if (!isUsableSumupId(sumupId)) {
    return unusable("id is not one we could have staged");
  }
  // Unsigned webhooks: only fetch checkouts we created. Spam and other
  // integrations' listings never cost an API call — one indexed read
  // answers the pre-filter and carries the sealed row for later. They are
  // refused retryably rather than acknowledged, because the same answer
  // covers a real callback racing our own staging write, and one fixed
  // refusal tells a forger nothing about whether an id exists.
  const sealed = await getSealedSumupCheckout(sumupId);
  if (sealed === null) {
    return unusable("checkout is not one we staged");
  }
  // The staged row already proved this checkout is ours, so anything but a
  // clean read is refused retryably: acknowledging is terminal, and a paid
  // checkout would be left with the money taken and no booking.
  const read = await sumupApi.readCheckoutById(sumupId);
  if (read.status !== "found") {
    return unusable(
      "reason" in read
        ? `read ${read.status} (${read.reason})`
        : "read missing",
    );
  }
  const checkout = read.resource;
  // From here SumUp has told us what the checkout is, so its own word is
  // carried out even when the rest of the read cannot be used.
  const reading = checkout.status;
  // The reference SumUp echoes back must be the one we generated for this
  // checkout and staged under this id — the sealed row only opens with it. If
  // it is unknown or another booking's, SumUp has contradicted itself about a
  // checkout we created: the booking is encrypted under that reference, so
  // without a match we can neither read it nor prove the charge is ours to
  // refund.
  const metadata = await openSumupCheckout(sealed, checkout.reference);
  if (metadata === null) {
    return {
      reading,
      resolved: refuseRetryably("reference does not open the staged row"),
    };
  }
  const session = buildSumupSession(checkout, metadata);
  // A charge the boundary could not read: surface the rejection so a paid
  // one still reaches the refund path.
  if (isSessionRejection(session)) return { reading, resolved: session };
  // Not yet (or never) paid: acknowledge without processing.
  return {
    reading,
    resolved: session.paymentStatus === "paid" ? session : "skip",
  };
};
