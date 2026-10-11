import {
  claimRegistrationWork,
  deliverRegistrationWork,
  payloadFreeTexts,
} from "#db/registration-notification-work.ts";
import {
  type CreatedEntry,
  promoCodeActivities,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";

export const completePaidBooking = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  codeSpecs: ModifierSpec[],
  modifierApplications: ModifierApplication[],
  ticketTokens: string[],
  /** Loaded package facts. A replay passes none, and the queue loads its own. */
  notificationPackages: RegistrationPackageFacts | undefined,
  sessionId: string,
): Promise<PaymentResult> => {
  // The answers save before the notification claims its work. A save that
  // fails leaves the work row unclaimed for the next delivery.
  await saveSessionAnswers(createdEntries, intent);
  const work = await claimRegistrationWork(sessionId);
  if (work.kind !== "claimed") {
    // Delivered: the notification already committed. Owned: a live delivery
    // holds the lease and finishes the tail. Either way this delivery must
    // not notify again.
    return sessionSuccess(
      createdEntries[0]!.attendee.id,
      createdEntries[0]!.listing.id,
      ticketTokens,
    );
  }
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
  await deliverRegistrationWork(sessionId, () =>
    logAndNotifyRegistration(createdEntries, {
      freeTexts: payloadFreeTexts(work.payload),
      packageFacts: notificationPackages,
      priorActivities: promoActivities,
      siteTokenIndex: intent.siteTokenIndex,
    }),
  );
  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};
