import { queryOne } from "#db/client.ts";
import {
  claimRegistrationEmail,
  finishRegistrationEmail,
} from "#db/registration-email-work.ts";
import { getActiveEmailConfig, sendEmail } from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { RegistrationDeliveryResult } from "#shared/registration-package-facts.ts";

/** One run sends at most this many messages, so a maintenance pass leaves
 * room for the rest of its budget and asks for a follow-up. */
const EMAIL_WORK_BATCH = 6;

/** What one claimed row ended in: nothing was due, it was delivered, or it
 * failed and stays due for a later retry. */
type OneDelivery = "none" | "delivered" | "failed";

const attendeeStillExists = async (attendeeId: number): Promise<boolean> =>
  (await queryOne<{ id: number }>(
    "SELECT id FROM attendees WHERE id = ? LIMIT 1",
    [attendeeId],
  )) !== null;

/** Send one due registration email. A claim owns one provider call, and a
 * lost provider reply can cause a resend — at-least-once, by owner choice. */
const deliverOne = async (): Promise<OneDelivery> => {
  const work = await claimRegistrationEmail();
  if (work === null) return "none";
  if (!(await attendeeStillExists(work.attendeeId))) {
    // An erased attendee must not receive mail about their erased booking.
    await finishRegistrationEmail(work, true);
    return "delivered";
  }
  const config = getActiveEmailConfig();
  if (config === null) {
    await finishRegistrationEmail(work, false);
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: "A registration email is due but email is not configured",
    });
    return "failed";
  }
  // sendEmail reports its own delivery failures to the operator.
  const delivery = await sendEmail(
    config,
    work.message,
    AbortSignal.timeout(15_000),
  );
  await finishRegistrationEmail(work, delivery.delivered);
  return delivery.delivered ? "delivered" : "failed";
};

/** Drain due registration emails. `failed` reports a delivery that stayed
 * due; `more` says the batch filled, so more work may remain. */
export const deliverDueRegistrationEmails = async (): Promise<
  RegistrationDeliveryResult & { more: boolean }
> => {
  let failed = false;
  for (let sent = 0; sent < EMAIL_WORK_BATCH; sent++) {
    const outcome = await deliverOne();
    if (outcome === "none") return { failed, more: false };
    failed = failed || outcome === "failed";
  }
  return { failed, more: true };
};
