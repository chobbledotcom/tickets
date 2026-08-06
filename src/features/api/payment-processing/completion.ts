import {
  type CreatedEntry,
  promoCodeActivities,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import type { PaidQuestionFacts } from "#routes/api/payment-processing/snapshot/types.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { logAndNotifyRegistration } from "#shared/webhook.ts";

export const completePaidBooking = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  codeSpecs: ModifierSpec[],
  modifierApplications: ModifierApplication[],
  ticketTokens: string[],
  questionFacts: PaidQuestionFacts,
  notificationPackages: RegistrationPackageFacts,
): Promise<PaymentResult> => {
  await saveSessionAnswers(createdEntries, intent, questionFacts);
  const firstEntry = createdEntries[0]!;
  const promoActivities =
    codeSpecs.length > 0
      ? promoCodeActivities(
          codeSpecs,
          modifierApplications,
          firstEntry.listing,
          firstEntry.attendee.id,
        )
      : [];
  await logAndNotifyRegistration(
    createdEntries,
    intent.siteTokenIndex,
    promoActivities,
    notificationPackages,
  );
  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};
