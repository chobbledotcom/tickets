import { queryOne } from "#db/client.ts";
import {
  claimRegistrationEmail,
  finishRegistrationEmail,
} from "#db/registration-email-work.ts";
import { deliverRegistrationEmail, getActiveEmailConfig } from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

const attendeeStillExists = async (attendeeId: number): Promise<boolean> =>
  (await queryOne<{ id: number }>(
    "SELECT id FROM attendees WHERE id = ? LIMIT 1",
    [attendeeId],
  )) !== null;

/** One claim owns one provider call. A lost provider reply can cause a resend. */
export const runRegistrationEmailWork = async (): Promise<boolean> => {
  const work = await claimRegistrationEmail();
  if (work === null) return false;
  if (!(await attendeeStillExists(work.attendeeId))) {
    await finishRegistrationEmail(work, true);
    return true;
  }
  const config = getActiveEmailConfig();
  if (config === null) {
    await finishRegistrationEmail(work, false);
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: "A registration email is due but email is not configured",
    });
    return true;
  }
  const delivery = await deliverRegistrationEmail(
    config,
    work.message,
    AbortSignal.timeout(15_000),
  );
  await finishRegistrationEmail(work, delivery.delivered);
  if (!delivery.delivered) {
    logError({
      code: ErrorCode.EMAIL_SEND,
      detail: delivery.detail,
      operatorDetail: delivery.reason || undefined,
    });
  }
  return true;
};
