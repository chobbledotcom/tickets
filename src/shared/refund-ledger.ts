/**
 * Ledger wiring for an admin full refund.
 *
 * The provider refund is a full refund of the booking payment (decision 9), so
 * the ledger mirrors it by reversing exactly the booking order's stored legs
 * (see {@link mapRefund}). The order is located from the attendee's own legs —
 * the group carrying the `sale` leg — the same way balance settlement finds
 * them, so a booking made before ledger dual-write (no legs) is skipped and left
 * for backfill rather than half-refunded.
 *
 * Posting never throws: the provider refund and the `refunded` flag have already
 * committed by the time we get here, so a ledger write must not turn a completed
 * refund into a 500. A failure is logged loudly (nothing reads the ledger yet,
 * and reconciliation surfaces a missing leg) instead.
 */

import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { mapRefund, refundEventGroup } from "#shared/accounting/mappers.ts";
import {
  transfersByAccount,
  transfersByEventGroup,
} from "#shared/accounting/queries.ts";
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

/**
 * The legs of the single booking order on this attendee's account, or `null`
 * when none applies: a booking that predates the ledger has no `sale` leg, and
 * an attendee carrying more than one booking order (a merge) can't be refunded
 * automatically — which order a payment maps to isn't recorded yet, so it needs
 * a manual ledger adjustment. Refund and balance-settlement groups are ignored
 * (they have no `sale` leg), so only the original booking is ever reversed.
 */
export const soleBookingOrder = (legs: Transfer[]): Transfer[] | null => {
  const bookingGroups = [...byEventGroup(legs).values()].filter((group) =>
    group.some((leg) => leg.kind === "sale"),
  );
  return bookingGroups.length === 1 ? bookingGroups[0]! : null;
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
    // Derive the refund's business time exactly once: if its event group is
    // already posted this is a benign re-submit, so skip rather than rebuild
    // legs with a fresh `nowIso()` that would look like a conflicting replay.
    const group = await refundEventGroup(order[0]!.eventGroup);
    if ((await transfersByEventGroup(group)).length > 0) return;
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
