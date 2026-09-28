/**
 * The paid booking's registration tail: save the buyer's answers, keep their
 * original wording, queue the confirmation emails durably, and only then
 * remove the staged checkout text. Every step is idempotent, so a replay of
 * an already-finalized session resumes here instead of reporting success
 * with the tail missing.
 */

/* jscpd:ignore-start -- imports */
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import type { ActivityToLog } from "#db/activity-log.ts";
import {
  deleteCheckoutAnswers,
  markCheckoutAnswersPaid,
  readCheckoutAnswers,
  sessionWorkIndex,
} from "#db/checkout-pending-answers.ts";
import { queryOne } from "#db/client.ts";
import { decryptSessionTokens } from "#db/processed-payments.ts";
import { requiredMapValue } from "#fp";
import { committedEntries } from "#routes/api/payment-processing/committed-entries.ts";
import {
  type CreatedEntry,
  promoCodeActivities,
  saveSessionAnswers,
  sessionSuccess,
} from "#routes/api/payment-processing/create.ts";
import { loadPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/io.ts";
import type {
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import type { ModifierApplication } from "#shared/checkout-pricing.ts";
import { saveSubmittedAnswerReceipts } from "#shared/email/answer-receipt.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { ModifierSpec } from "#shared/payments.ts";
import type { RegistrationPackageFacts } from "#shared/registration-package-facts.ts";
import { logAndNotifyRegistration } from "#shared/webhook/delivery.ts";
/* jscpd:ignore-end */

/** The shared, idempotent tail every paid completion and replay runs. A
 * checkout created before this release has no staged row: the booking still
 * completes, its emails degrade loudly to choice answers only, and no
 * receipt is written — the legacy reader serves that booking. */
export const completeRegistrationTail = async (
  sessionId: string,
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  notificationPackages: RegistrationPackageFacts,
  promoActivities: readonly ActivityToLog[],
): Promise<void> => {
  const staged = await readCheckoutAnswers(sessionId);
  const texts = staged?.texts ?? new Map();
  if (staged === null) {
    // The hashed index, not the raw session id: for SumUp the id is the
    // checkout reference, which must not reach logs or sinks either.
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `A paid checkout predates staged answers (session index ${await sessionWorkIndex(
        sessionId,
      )}); its emails will show choice answers only`,
    });
  } else {
    await markCheckoutAnswersPaid(sessionId);
  }
  await saveSessionAnswers(createdEntries, intent, texts);
  if (staged !== null) {
    await saveSubmittedAnswerReceipts(createdEntries, staged.snapshot);
  }
  await logAndNotifyRegistration(createdEntries, {
    freeTexts: texts,
    packageFacts: notificationPackages,
    priorActivities: promoActivities,
    sessionId,
    siteTokenIndex: intent.siteTokenIndex,
  });
  if (staged !== null) {
    await deleteCheckoutAnswers(sessionId);
  }
};

export const completePaidBooking = async (
  createdEntries: CreatedEntry[],
  intent: BookingIntent,
  codeSpecs: ModifierSpec[],
  modifierApplications: ModifierApplication[],
  ticketTokens: string[],
  notificationPackages: RegistrationPackageFacts,
  sessionId: string,
): Promise<PaymentResult> => {
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
  await completeRegistrationTail(
    sessionId,
    createdEntries,
    intent,
    notificationPackages,
    promoActivities,
  );
  return sessionSuccess(
    firstEntry.attendee.id,
    firstEntry.listing.id,
    ticketTokens,
  );
};

/** A session whose paid outcome is fully recorded needs no email tail: close
 * its staging so the cancellation worker stops asking about it. */
export const closePaidCheckoutStaging = async (
  sessionId: string,
): Promise<void> => {
  await markCheckoutAnswersPaid(sessionId);
  await deleteCheckoutAnswers(sessionId);
};

/** The first stored ticket token for a finalized session, or null when none
 * is recoverable. The confirmation email renders its ticket links from this
 * token, so a pruned payment row means the email cannot be built truthfully. */
const firstTicketTokenOf = async (
  sessionId: string,
): Promise<string | null> => {
  const existing = await queryOne<{ ticket_tokens: EnvKeyEncrypted | "" }>(
    "SELECT ticket_tokens FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );
  if (!existing || existing.ticket_tokens === "") return null;
  const decrypted = await decryptSessionTokens(existing.ticket_tokens);
  return decrypted ? decrypted.split("+")[0]! : null;
};

/** Resume the registration tail of a session whose booking is already
 * finalized: the crash window between the payment finalize and the tail. A
 * staged row that is gone means the tail already ran. A token that is gone
 * means the email cannot render a live ticket link, so the row is left for
 * the terminal sweep and the operator's admin resend. */
export const resumeFinalizedSession = async (
  sessionId: string,
  attendeeId: number,
  data: ValidatedSession,
): Promise<void> => {
  const { session, intent } = data;
  if (intent.balanceAttendeeId) {
    await closePaidCheckoutStaging(sessionId);
    return;
  }
  if ((await readCheckoutAnswers(sessionId)) === null) return;
  const ticketToken = await firstTicketTokenOf(sessionId);
  if (ticketToken === null) {
    logError({
      code: ErrorCode.PAYMENT_SESSION,
      detail:
        `A paid booking's confirmation could not resume because its ticket ` +
        `token is gone (session index ${await sessionWorkIndex(sessionId)}); ` +
        "the admin resend remains its recovery",
    });
    return;
  }
  const snapshot = await loadPaidOrderSnapshot(sessionId, intent);
  const listings = intent.items.map((item) =>
    requiredMapValue(
      snapshot.listingsById,
      item.e,
      `Listing ${item.e} is gone, so the paid booking's confirmation cannot be rebuilt`,
    ),
  );
  const entries = await committedEntries(
    attendeeId,
    ticketToken,
    session,
    intent,
    listings.map((listing) => ({ listing })),
  );
  await completeRegistrationTail(
    sessionId,
    entries,
    intent,
    snapshot.notificationPackages,
    [],
  );
};
