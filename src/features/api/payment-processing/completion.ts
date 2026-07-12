import {
  type CreatedEntry,
  logPromoCodeModifiers,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import type {
  BookingIntent,
  PaymentResult,
} from "#routes/api/webhook-types.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";

/** Finish the work that follows an atomically committed paid booking. Shared by
 * the normal create result and recovery after the database committed but the
 * client lost that result. */
export const completePaidBooking = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  codeSpecs: ModifierSpec[],
  modifierApplications: ModifierApplication[],
  ticketTokens: string[],
): Promise<PaymentResult> => {
  await saveSessionAnswers(createdEntries, intent);
  const firstEntry = createdEntries[0]!;

  if (codeSpecs.length > 0) {
    await logPromoCodeModifiers(
      codeSpecs,
      modifierApplications,
      firstEntry.listing,
      firstEntry.attendee.id,
    );
  }

  await logAndNotifyRegistration(createdEntries, intent.siteTokenIndex);

  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};
