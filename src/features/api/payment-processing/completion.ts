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

/** Finish every effect after a paid booking has definitely committed. */
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
