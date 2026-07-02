/**
 * Loader for the attendee Balance tab: the deposit/balance breakdown, the
 * secure customer payment link, and the payment history. Rendered by the
 * attendee entity page (attendee-page.ts); the tab is owner-only, matching
 * the money-exposing Ledger tab.
 */

import { signBalanceToken } from "#shared/balance-link.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { getAttendeeActivityLog } from "#shared/db/activityLog.ts";
import { getAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
} from "#shared/db/attendees/balance.ts";
import { computeReservationDeposit } from "#shared/reservation-amount.ts";
import { AttendeeBalancePanel } from "#templates/admin/attendee-balance.tsx";

/** Build the Balance tab's panel for an already-loaded attendee. */
export const loadAttendeeBalancePanel = async (
  attendeeId: number,
  baseUrl: string,
): Promise<JSX.Element> => {
  // The entity page already loaded this attendee, so its balance state exists.
  const state = (await getAttendeeBalanceState(attendeeId))!;

  const [status, summary, history, token] = await Promise.all([
    state.statusId ? getAttendeeStatus(state.statusId) : Promise.resolve(null),
    getAttendeeOrderSummary(attendeeId),
    getAttendeeActivityLog(attendeeId),
    signBalanceToken(attendeeId),
  ]);

  const deposit = status?.is_reservation
    ? computeReservationDeposit(
        status.reservation_amount,
        summary.fullPrice,
        summary.totalQuantity,
      )
    : 0;

  return AttendeeBalancePanel({
    deposit,
    history,
    link: `${baseUrl}/pay/${token}`,
    // The customer pay link only works when a provider can take the payment;
    // without one, the /pay POST dead-ends, so the template withholds it.
    paymentsEnabled: isPaymentsEnabled(),
    remainingBalance: state.remainingBalance,
    status,
    summary,
  });
};
