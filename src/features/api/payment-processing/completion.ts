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
import { heldTailAnswer } from "#routes/api/payment-processing/replay-tail.ts";
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
  if (work.kind === "delivered") {
    // The notification already committed. This delivery must not send again.
    return sessionSuccess(
      createdEntries[0]!.attendee.id,
      createdEntries[0]!.listing.id,
      ticketTokens,
    );
  }
  if (work.kind === "owned") {
    // A held lease is not a finished tail: its holder can die after
    // claiming. Answer retryably so the provider comes back after the
    // holder finishes or the lease goes stale.
    return heldTailAnswer();
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
  await deliverRegistrationWork(work.lease, (signal) =>
    logAndNotifyRegistration(createdEntries, {
      awaitNotifications: true,
      freeTexts: payloadFreeTexts(work.payload),
      packageFacts: notificationPackages,
      priorActivities: promoActivities,
      signal,
      siteTokenIndex: intent.siteTokenIndex,
    }),
  );
  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};
