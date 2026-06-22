/**
 * Ledger wiring for an admin full refund.
 *
 * The provider refund is a full refund of the booking payment (decision 9), so
 * the ledger mirrors it by reversing exactly the booking order's stored legs
 * (see {@link mapRefund}). It only auto-reverses when the refund maps cleanly:
 * the attendee's ledger is exactly one revenue-recognising booking group (see
 * {@link soleBookingOrder}) that is **paid in full**. Pre-ledger, balance-settled,
 * merged, or still-owing accounts are left for a manual adjustment rather than
 * half- or over-reversed.
 *
 * Posting never throws: the provider refund has already committed by the time we
 * get here, so a ledger write must not turn a completed refund into a 500. But
 * with the `refunded` column gone, the `refund_cash` leg is the *only* record of
 * the refund, so a missed post can't be swallowed silently or the payment would
 * read as un-refunded and stay re-refundable. Instead it returns `{ posted }`:
 * `false` means the ledger does not reflect the refund (a guard-skip to manual
 * adjustment, or a logged write failure), which the caller surfaces.
 */

import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { mapRefund } from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransferGroups, postTransfers } from "#shared/accounting/store.ts";
import { balanceOf } from "#shared/ledger/project.ts";
import type { Transfer, TransferInput } from "#shared/ledger/types.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";

/** Group an account's legs by their event group, preserving order. */
const byEventGroup = (legs: Transfer[]): Map<string, Transfer[]> => {
  const groups = new Map<string, Transfer[]>();
  for (const leg of legs) {
    const group = groups.get(leg.eventGroup);
    if (group) group.push(leg);
    else groups.set(leg.eventGroup, [leg]);
  }
  return groups;
};

/** A revenue-recognising leg marks a group as a real booking order: a free
 *  listing with a paid surcharge has a `modifier`/`fee` leg but no `sale`, while
 *  a balance settlement posts only a `payment` leg. */
const recognisesRevenue = (kind: string | undefined): boolean =>
  kind === "sale" || kind === "fee" || kind === "modifier";

/**
 * The booking legs to reverse when — and only when — a full provider refund of
 * the original payment maps cleanly onto the ledger: the account holds exactly
 * one event group and that group recognises revenue. Returns `null` for
 * everything else, so those go to a manual ledger adjustment instead of being
 * mis-reversed:
 * - no legs at all — a booking that predates ledger dual-write (backfill's job);
 * - a group with only a `payment` leg — a later `balance` settlement, whose cash
 *   this refund doesn't return, so reversing the booking alone would strand it;
 * - more than one group — a settled reservation (booking + balance) or a merge's
 *   several orders, where one payment refund can't be attributed to one order.
 */
export const soleBookingOrder = (legs: Transfer[]): Transfer[] | null => {
  const groups = byEventGroup(legs);
  if (groups.size !== 1) return null;
  const order = [...groups.values()][0]!;
  return order.some((leg) => recognisesRevenue(leg.kind)) ? order : null;
};

/**
 * Compute one attendee's refund reversal without posting it: the ledger legs to
 * write (empty when already refunded or not a clean order) and whether the ledger
 * records — or will record — the refund. Read-only, so the bulk path can compute
 * many in parallel and post them in one transaction. Shared by the single
 * {@link recordAttendeeRefund} and the batched {@link recordAttendeeRefundsBatch}.
 */
const computeAttendeeRefund = async (
  attendeeId: number,
): Promise<{ posted: boolean; legs: TransferInput[] }> => {
  const account = attendeeAccount(attendeeId);
  const legs = await transfersByAccount(account);
  // Already refunded (e.g. an idempotent re-submit): the `refund_cash` leg is the
  // durable refund record, so report success without re-posting — and without
  // rebuilding legs under a fresh `nowIso()`.
  if (legs.some((leg) => leg.kind === "refund_cash")) {
    return { legs: [], posted: true };
  }
  const order = soleBookingOrder(legs);
  if (order === null) return { legs: [], posted: false };
  // Only auto-reverse a fully-paid booking. If the attendee still owes (an unpaid
  // reservation) or holds credit, this single full provider refund can't map
  // cleanly onto the ledger: reversing the sale while the balance stays payable
  // would let a later balance payment post against it. Such cases go to a manual
  // adjustment instead.
  if (balanceOf(account)(legs) !== 0) return { legs: [], posted: false };
  return {
    legs: await mapRefund({ occurredAt: nowIso(), orderLegs: order }),
    posted: true,
  };
};

/**
 * Post the ledger legs reversing one attendee's booking and report whether the
 * ledger records the refund. `{ posted: true }` when it posts the reversal — or
 * when the attendee is already refunded, so an idempotent re-submit is a no-op
 * success. `{ posted: false }` when the booking isn't a single fully-paid
 * ledgered order (→ manual adjustment) or the write fails. Never throws.
 */
export const recordAttendeeRefund = async (
  attendeeId: number,
): Promise<{ posted: boolean }> => {
  try {
    const { posted, legs } = await computeAttendeeRefund(attendeeId);
    if (legs.length > 0) await postTransfers(legs);
    return { posted };
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `refund ledger post failed for attendee ${attendeeId}: ${error}`,
    });
    return { posted: false };
  }
};

/**
 * Record refunds for many attendees in ONE write transaction, returning each
 * attendee's posted status. A bulk refund would otherwise open an interactive
 * write transaction per attendee and contend the single SQLite writer
 * (SQLITE_BUSY) once enough overlap — and that swallowed loss, now that refund
 * status is ledger-only, would silently leave payments re-refundable. So the
 * per-attendee reversals are computed read-only and posted together. On a write
 * failure no new reversal is recorded (already-refunded attendees stay refunded).
 * Never throws.
 */
export const recordAttendeeRefundsBatch = async (
  attendeeIds: number[],
): Promise<Map<number, boolean>> => {
  // Compute sequentially: overlapping reads (Promise.all) can leave statements
  // open that collide with the batch transaction's commit at scale.
  const computed: { id: number; posted: boolean; legs: TransferInput[] }[] = [];
  for (const id of attendeeIds) {
    computed.push({ id, ...(await computeAttendeeRefund(id)) });
  }
  const groups = computed
    .map((entry) => entry.legs)
    .filter((legs) => legs.length > 0);
  try {
    if (groups.length > 0) await postTransferGroups(groups);
    return new Map(computed.map((entry) => [entry.id, entry.posted]));
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `bulk refund ledger post failed (${attendeeIds.length}): ${error}`,
    });
    // The single batched post failed: only attendees that already carried a
    // refund_cash leg (no new legs to write) remain recorded as refunded.
    return new Map(
      computed.map((entry) => [
        entry.id,
        entry.legs.length === 0 ? entry.posted : false,
      ]),
    );
  }
};
