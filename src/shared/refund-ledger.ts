/**
 * Ledger wiring for an admin full refund.
 *
 * The provider refund is a full refund of the booking payment (decision 9), so
 * the ledger mirrors it by reversing exactly the booking order's stored legs
 * (see {@link mapRefund}). It only auto-reverses when the refund maps cleanly:
 * the attendee's ledger is exactly one revenue-recognising booking group (see
 * {@link soleBookingOrder}). Pre-ledger, balance-settled, and merged accounts
 * are left for a manual adjustment rather than half- or over-reversed.
 *
 * Posting never throws: the provider refund and the `refunded` flag have already
 * committed by the time we get here, so a ledger write must not turn a completed
 * refund into a 500. A failure is logged loudly (nothing reads the ledger yet,
 * and reconciliation surfaces a missing leg) instead.
 */

import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { mapRefund } from "#shared/accounting/mappers.ts";
import { transfersByAccount } from "#shared/accounting/queries.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { Transfer } from "#shared/ledger/types.ts";
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
 * Post the ledger legs reversing one attendee's booking. A no-op when the
 * booking isn't a single ledgered order (see {@link soleBookingOrder}); a
 * re-submit replays the same refund event group as a no-op. Never throws.
 */
export const recordAttendeeRefund = async (
  attendeeId: number,
): Promise<void> => {
  try {
    const order = soleBookingOrder(
      await transfersByAccount(attendeeAccount(attendeeId)),
    );
    if (order === null) return;
    // Idempotent without a pre-check: once the refund is posted the account has
    // two event groups (booking + refund), so a re-submit fails the single-group
    // test above and skips rather than rebuilding legs with a fresh `nowIso()`.
    await postTransfers(
      await mapRefund({ occurredAt: nowIso(), orderLegs: order }),
    );
  } catch (error) {
    logError({
      code: ErrorCode.LEDGER_POST,
      detail: `refund ledger post failed for attendee ${attendeeId}: ${error}`,
    });
  }
};
