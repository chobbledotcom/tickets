/** The failure reports one registration send owes when its delivery dies:
 * the operator-facing activity line, and the owner's error fan-out. */

import { logActivities } from "#db/activity-log.ts";
import { t, withMessageGroups } from "#i18n";
import { ErrorCode, logErrorLocal } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { captureServerError } from "#shared/sentry.ts";

/** Record the operator-facing activity line for one refused delivery. */
export const recordRegistrationDeliveryFailure = async (): Promise<void> => {
  try {
    await withMessageGroups(["activity-log"], () =>
      logActivities([{ message: t("admin.log.registration_delivery_failed") }]),
    );
  } catch (error) {
    logErrorLocal({
      code: ErrorCode.DB_QUERY,
      detail: "Registration delivery failure activity write",
    });
    throw error;
  }
};

/** Report one registration send's delivery failure: the log, the failure
 * activity when no flag represents it, and the owner's ntfy and Sentry
 * fan-out. */
export const reportRegistrationDeliveryError = async (
  recordFailure: boolean,
): Promise<void> => {
  const context = { code: ErrorCode.REGISTRATION_DELIVERY };
  logErrorLocal(context);
  if (recordFailure) await recordRegistrationDeliveryFailure();
  addPendingWork(sendNtfyError(context.code));
  addPendingWork(captureServerError(context));
};
