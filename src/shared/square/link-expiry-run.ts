/**
 * One pass of the Square link expiry task: take the link ends whose attempt
 * time has come, end each link at Square, and move its row on by what the
 * answer proved.
 *
 * Nothing here decides money. Ending a link changes no attendee, capacity,
 * or payment state — the webhook and the return path own completion, and a
 * payment that arrives on a link we ended is processed exactly as today.
 */

import { decrypt } from "#crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#crypto/sealed.ts";
import {
  applySquareLinkEndEvent,
  claimSquareLinkEnd,
  type DueSquareLinkEnd,
  getDueSquareLinkEnds,
} from "#db/square-link-ends.ts";
import type { SquareLinkEndEventId } from "#payment/square-link-end-machine-spec.ts";
import { SQUARE_LINK_EXPIRY_BATCH } from "#shared/limits.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import { squareApi } from "#shared/square/api.ts";
import { squareLinkEndEventOf } from "#shared/square/link-end.ts";

/** End one link and record what the answer amounted to.
 *
 * Asking is caught per row: one link blowing up must not stop the rows behind
 * it. Recording the answer is not caught — a refused write is the database's
 * problem, not this row's, and throws to the task's own retry. */
const endOne = async (row: DueSquareLinkEnd): Promise<void> => {
  if (row.state === "ending") {
    // The lease expired without an answer, so the row returns to the queue
    // and the next run claims it afresh.
    const wrote = await applySquareLinkEndEvent(row, "lease_expired");
    logDebug(
      "Square",
      wrote
        ? "Link end lease expired back to pending"
        : "Link end lease was answered by another runner",
    );
    return;
  }
  const leaseUntil = await claimSquareLinkEnd(row);
  if (leaseUntil === null) {
    // Another runner holds the row, or the completion took it.
    return;
  }
  const claimed: DueSquareLinkEnd = {
    ...row,
    claimedAt: leaseUntil,
    state: "ending",
  };
  let event: SquareLinkEndEventId;
  try {
    const linkId = await decrypt(row.sealedHandle as EnvKeyEncrypted);
    event = squareLinkEndEventOf(await squareApi.endLink(linkId));
  } catch (error) {
    logError({
      code: ErrorCode.SQUARE_CHECKOUT,
      detail: `Square link end failed for ${row.sessionIndex}: ${error instanceof Error ? error.message : String(error)}`,
    });
    // The send failed or the answer never came back, so the row waits out
    // the failure retry — the documented outcome of a delete that proved
    // nothing.
    await applySquareLinkEndEvent(claimed, "delete_inconclusive");
    return;
  }
  const wrote = await applySquareLinkEndEvent(claimed, event);
  // Losing the write means another runner answered this row first, with the
  // same evidence. Its answer stands; ours would only overwrite the attempt
  // time it just set.
  logDebug(
    "Square",
    wrote ? `Link end answered ${event}` : "Link end was beaten to a row",
  );
};

/**
 * Run one batch. Returns whether a full batch was taken, so the caller can
 * ask to be run again rather than working through a backlog inside one
 * request's subrequest budget.
 */
export const runSquareLinkExpiry = async (): Promise<boolean> => {
  const due = await getDueSquareLinkEnds();
  for (const row of due) {
    await endOne(row);
  }
  return due.length === SQUARE_LINK_EXPIRY_BATCH;
};
