import { hmacHash } from "#crypto/hashing.ts";
import { takeCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import {
  type CreatedEntry,
  promoCodeActivities,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import type { PaymentResult } from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";

export const completePaidBooking = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  codeSpecs: ModifierSpec[],
  modifierApplications: ModifierApplication[],
  ticketTokens: string[],
  notificationPackages: RegistrationPackageFacts,
  sessionId: string,
): Promise<PaymentResult> => {
  // The answers save before the staged row is taken. A save that fails must
  // leave the staged plaintext in place, not destroy the only copy the
  // completion's emails can read.
  await saveSessionAnswers(createdEntries, intent);
  const freeTexts = intent.listingTextAnswerIds
    ? await takeCheckoutAnswers(sessionId)
    : undefined;
  if (freeTexts?.size === 0) {
    // The hashed index, not the raw session id: for SumUp the id is the
    // checkout reference, which must not reach logs or sinks either.
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `A paid checkout carried text answers but its staged row is gone (session index ${await hmacHash(sessionId)}); its emails will show choice answers only`,
    });
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
  await logAndNotifyRegistration(createdEntries, {
    freeTexts,
    packageFacts: notificationPackages,
    priorActivities: promoActivities,
    siteTokenIndex: intent.siteTokenIndex,
  });
  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};
