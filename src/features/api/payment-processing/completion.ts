/* jscpd:ignore-start */
import {
  type CreatedEntry,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { queueRegistrationSends } from "#shared/webhook/delivery.ts";
/* jscpd:ignore-end */

/**
 * Queue a paid booking's external sends after its create batch committed.
 * The batch already wrote the booking, its answers, and its activity lines.
 * This queues the confirmation email and the registration webhooks without
 * writing the registration activity again. No post-commit database write
 * stands between the committed booking and its sends.
 *
 * A redelivery that finds the booking already exists never reaches this: the
 * ledger replay answers success first, so the sends are queued once.
 */
export const completePaidBooking = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  ticketTokens: string[],
  notificationPackages: RegistrationPackageFacts,
  freeTexts: FreeTextAnswers | undefined,
): Promise<PaymentResult> => {
  const firstEntry = createdEntries[0]!;
  await queueRegistrationSends(createdEntries, {
    freeTexts,
    packageFacts: notificationPackages,
    siteTokenIndex: intent.siteTokenIndex,
    source: "public",
  });
  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};
