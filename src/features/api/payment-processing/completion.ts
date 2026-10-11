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
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";

/** Take the checkout's staged free-text answers back. Say loudly when a
 * checkout that carried text answers finds its row gone: the strings table
 * still seals every answer for the admin re-send. The emails this
 * completion queues will show choice answers only. Shared by the fresh
 * completion and a replay's resumed tail. */
export const takeSessionAnswers = async (
  sessionId: string,
  intent: BookingIntent,
): Promise<FreeTextAnswers | undefined> => {
  if (!intent.listingTextAnswerIds) return;
  const freeTexts = await takeCheckoutAnswers(sessionId);
  if (freeTexts.size === 0) {
    // The hashed index, not the raw session id: for SumUp the id is the
    // checkout reference, which must not reach logs or sinks either.
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `A paid checkout carried text answers but its staged row is gone (session index ${await hmacHash(sessionId)}); its emails will show choice answers only`,
    });
  }
  return freeTexts;
};

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
  // The answers save before the staged row is taken. A save that fails must
  // leave the staged plaintext in place, not destroy the only copy the
  // completion's emails can read.
  await saveSessionAnswers(createdEntries, intent);
  const freeTexts = await takeSessionAnswers(sessionId, intent);
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
