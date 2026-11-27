/**
 * A paid checkout of ours whose sealed order is gone or will not open.
 *
 * The buyer paid and the site cannot book them. The callback stays retryable,
 * because a lost row can come back from a restore. The site sends no refund:
 * only an admin decides what happens to the money. The admin is told in three
 * places: the error log, the listing's notes, and the activity log. The note
 * and the activity line land once per payment, however often the provider
 * retries. A subscription keeps charging until somebody cancels it, so its
 * note names the subscription.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { logActivity } from "#db/activity-log.ts";
import { withTransaction } from "#db/client.ts";
import { createSystemNote } from "#db/notes/queries.ts";
import { noteTargets } from "#db/notes/target.ts";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { requireValue } from "#shared/required-value.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";

/** Why the order cannot be opened, in the words an admin reads. */
const REASON_TEXT = {
  bundle_missing: () => t("payment.lost_order.bundle_missing"),
  bundle_unreadable: () => t("payment.lost_order.bundle_unreadable"),
} as const;

export type LostBundleReason = keyof typeof REASON_TEXT;

/** The subscription that the checkout started, for the error log. */
const subscriptionDetail = (session: ValidatedPaymentSession): string =>
  session.subscription === undefined
    ? ""
    : `, subscription=${session.subscription.id}`;

/** The note on the listing. A checkout that started a subscription says so,
 * because a refund of the payment does not end the subscription. */
const noteFor = (
  session: ValidatedPaymentSession,
  facts: Record<string, string>,
): string =>
  session.subscription === undefined
    ? t("payment.lost_order.note", facts)
    : t("payment.lost_order.note_subscription", {
        ...facts,
        subscription: session.subscription.id,
      });

/** Tell the admin about a paid checkout that cannot be booked. */
export const reportLostBundle = async (
  session: ValidatedPaymentSession,
  reason: LostBundleReason,
): Promise<void> => {
  const listingId = requireValue(
    parsePositiveInt(session.metadata.listing),
    `Signed session ${session.id} names no listing`,
  );
  logError({
    code: ErrorCode.PAYMENT_SESSION,
    detail: `Paid checkout has no usable sealed order: ${reason} (session=${session.id}, provider=${session.provider}, payment=${session.paymentReference}, amount=${session.amountTotal} ${session.currency}${subscriptionDetail(session)})`,
    listingId,
  });
  const facts = {
    amount: formatCurrency(session.amountTotal),
    provider: PAYMENT_PROVIDERS[session.provider].label,
    reason: REASON_TEXT[reason](),
    reference: session.paymentReference,
  };
  await withTransaction(async (tx) => {
    const written = await createSystemNote(
      noteTargets.of("listing")(listingId),
      noteFor(session, facts),
      { key: await hmacHash(session.id), purpose: "checkout_bundle_lost" },
      tx,
    );
    if (written) {
      await logActivity(
        t("payment.lost_order.activity", facts),
        listingId,
        null,
        tx,
      );
    }
  });
};
