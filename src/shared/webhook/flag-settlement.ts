/** Settling the pending-notification flags one registration send owns: which
 * sides it queues, the flag writes its outcome earns, and the owner-copy
 * fact its report needs. */

import {
  type ClaimedNotificationSide,
  clearPendingFlagStatement,
  type PendingNotificationSide,
  restorePendingFlagStatement,
} from "#db/attendees/notification-flags.ts";
import { executeBatch, type SqlStatement } from "#db/client.ts";
import type { RegistrationEmailResult } from "#shared/email/registration.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  RegistrationDeliveryError,
  type RegistrationDeliveryResult,
} from "#shared/registration-package-facts.ts";

/** The outstanding sides a recovery claimed. */
type RecoveredSides = readonly ClaimedNotificationSide[] | undefined;

/** The sides a press chose on the manual re-send. Absent on every other
 * path, where the send decides its sides itself. */
export type ChosenSides = Record<PendingNotificationSide, boolean>;

/** Which sides a send queues. A recovery queues only the sides it claimed.
 * Every other path queues both. A press that chose its sides queues exactly
 * the chosen ones. The choice decides what goes out. The claimed sides it
 * holds decide what the send settles. */
export const selectedSides = (
  recovered: RecoveredSides,
  chosen: ChosenSides | undefined,
): ChosenSides =>
  chosen ?? {
    email:
      recovered === undefined || recovered.some(({ side }) => side === "email"),
    webhooks:
      recovered === undefined ||
      recovered.some(({ side }) => side === "webhooks"),
  };

/** Whether a send's far side accepted everything it was given: the send
 * settled, and none of its deliveries was refused. */
const acceptedDelivery = (
  result: PromiseSettledResult<RegistrationDeliveryResult>,
): boolean => result.status === "fulfilled" && !result.value.failed;

/** The flag writes one settled send earned. A side whose send cleared writes
 * a clear. A claimed side whose send did not clear writes its captured
 * value back, so the release keeps the badge's own colour. When a claim
 * ran, a clear needs the claim. A forced side the claim never held settles
 * nothing: a refused claim's restore can raise that flag for its own
 * recovery. */
const earnedFlagWrites = (
  clearPendingFlagsFor: readonly number[],
  cleared: Record<PendingNotificationSide, boolean>,
  recovered: RecoveredSides,
): { clears: SqlStatement[]; restores: SqlStatement[] } => {
  const clears: SqlStatement[] = [];
  const restores: SqlStatement[] = [];
  for (const side of ["email", "webhooks"] as const) {
    if (cleared[side]) {
      const claimed =
        recovered === undefined || recovered.some((one) => one.side === side);
      if (claimed) {
        clears.push(clearPendingFlagStatement(side, clearPendingFlagsFor));
      }
      continue;
    }
    const claimed = recovered?.find((one) => one.side === side);
    if (claimed) {
      restores.push(
        restorePendingFlagStatement(
          side,
          clearPendingFlagsFor,
          claimed.previous,
        ),
      );
    }
  }
  return { clears, restores };
};

/** Clear the pending flags one flag-owning send earned, and restore each
 * claimed side that did not clear to its captured value. A side clears only
 * when its send was attempted and its far side accepted. The buyer
 * confirmation's refusal is the email flag's subject, and a webhook refusal
 * is the webhooks flag's. The email side's per-message outcomes ride both
 * settled states: the fulfilled value, and a template error's enriched
 * RegistrationDeliveryError. Any other rejection threw before a delivery
 * was attempted, so no side speaks. A failed settle batch only logs, so the
 * send's own report stands. Returns whether an owner-copy failure no flag
 * represents happened, for the caller's failure report. */
export const settleFlagOwningSend = async (
  clearPendingFlagsFor: readonly number[],
  attempted: { email: boolean; webhooks: boolean },
  webhookResult: PromiseSettledResult<RegistrationDeliveryResult>,
  emailResult: PromiseSettledResult<RegistrationEmailResult>,
  recovered: RecoveredSides,
): Promise<boolean> => {
  const emailSide =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : emailResult.reason instanceof RegistrationDeliveryError
        ? emailResult.reason
        : undefined;
  const buyerFlagClears =
    attempted.email && emailSide !== undefined && !emailSide.buyerFailed;
  const webhooksFlagClears =
    attempted.webhooks && acceptedDelivery(webhookResult);
  const { clears, restores } = earnedFlagWrites(
    clearPendingFlagsFor,
    { email: buyerFlagClears, webhooks: webhooksFlagClears },
    recovered,
  );
  const statements = [...clears, ...restores];
  if (statements.length > 0) {
    await executeBatch(statements).catch(async (error) => {
      await logError({
        code: ErrorCode.DB_QUERY,
        detail: `The pending-flag settle batch failed: ${String(error)}`,
      });
      // The batch is one transaction, and none of its writes landed. A
      // claimed side that did not clear is still zero and hides its owed
      // send. Give each restore its own write. One refused value's
      // failure then does not hide the others. A restore that still fails
      // is logged with its side. That flag stays zero until the admin
      // investigates the logged incident.
      for (const restore of restores) {
        await executeBatch([restore]).catch(async (restoreError) => {
          await logError({
            code: ErrorCode.DB_QUERY,
            detail: `A pending-flag restore was still refused and its owed send stays hidden: ${String(restoreError)}`,
          });
        });
      }
    });
  }
  return emailSide !== undefined ? emailSide.ownerFailed : false;
};
