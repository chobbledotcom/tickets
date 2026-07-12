/**
 * Surface a stranded refund — a provider refund that committed but the ledger
 * did not record — to the operator, through both channels they'd look in: the
 * classified error alert (console + ntfy + activity log + Sentry) AND a note on
 * each affected attendee's own record.
 */

import { createSystemNoteOnce } from "#shared/db/system-notes.ts";
import { bestEffort, ErrorCode, logError } from "#shared/logger.ts";

/**
 * The PII-free note left on a stranded attendee's record. Deliberately plain
 * text with NO ledger link: the ledger routes are owner-only, but these notes
 * render for managers and editors too (attendee banner, attendee list, listing
 * Overview/Roster), so a `[ledger](…)` link would be a forbidden link that 403s
 * for them. It names the reason and that an owner must act — the note is already
 * attached to the attendee, so it needs no id in the text.
 */
const strandedRefundNote = (): string =>
  "A refund for this booking was completed at the payment provider, but the ledger did not record it — the account is not fully paid, or has no clean order to reverse. An owner needs to post a manual adjustment in the ledger.";

/**
 * Alert that a provider refund committed but the ledger did not record it — a
 * guard-skip to manual adjustment (not a thrown write, which logs LEDGER_POST
 * with its stack). This money-integrity miss must reach the error log, ntfy, and
 * Sentry, never only a dismissible admin flash. The attendee id(s) are named in
 * the `detail` (not just the `attendeeId` tag) because the activity log persists
 * only the formatted message — `persistErrorToActivityLog` passes `listingId`,
 * never `attendeeId`. A whole batch reports in ONE `logError` call: the persist
 * guard is a single flag, so back-to-back calls drop all but the first.
 *
 * It also leaves a system note on EACH stranded attendee's record, so the miss
 * is visible where the operator manages the booking, not only in the error log.
 * Best-effort: a note-write failure must never turn an already-committed refund
 * into a 500 (the refund path never throws). Never throws.
 */
export const reportRefundNotRecorded = async (
  attendeeIds: readonly number[],
): Promise<void> => {
  if (attendeeIds.length === 0) return;
  const who =
    attendeeIds.length === 1
      ? `attendee ${attendeeIds[0]}`
      : `attendees ${attendeeIds.join(", ")}`;
  logError({
    // One attendee tags the Sentry event for filtering; a batch names them all
    // in the detail instead, since a single tag can't hold a list.
    attendeeId: attendeeIds.length === 1 ? attendeeIds[0] : undefined,
    code: ErrorCode.REFUND_NOT_RECORDED,
    detail: `provider refund committed but the ledger did not record it for ${who} — manual adjustment needed`,
  });
  // Serialize the note writes (not Promise.all): each is its own INSERT, so
  // firing them concurrently would contend the single SQLite writer — the same
  // reason the per-attendee refund fallback records one at a time — and a note
  // that lost that race would be swallowed by best-effort and silently dropped.
  // createSystemNoteOnce keeps it idempotent: a retried stranded refund (the
  // provider already refunded, but the ledger still can't record it) re-enters
  // this path, and we must not stack a duplicate alert on each attempt.
  const note = strandedRefundNote();
  for (const attendeeId of attendeeIds) {
    await bestEffort(
      `refund-not-recorded note for attendee ${attendeeId}`,
      () => createSystemNoteOnce(attendeeId, note),
    );
  }
};
