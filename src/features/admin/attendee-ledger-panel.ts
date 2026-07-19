/**
 * Loader for the attendee Ledger tab: the plain-language order summary, the
 * shared account statement (the source of truth), how to collect any balance
 * (customer pay link or offline guidance), and a short activity history.
 * Rendered by the attendee entity page (attendee-page.ts); the tab is
 * owner-only, matching the money-exposing standalone /admin/ledger routes.
 */

import { loadAccountLedger } from "#routes/admin/ledger/statements.ts";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { signBalanceToken } from "#shared/balance-link.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { getAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
} from "#shared/db/attendees/balance.ts";
import { computeReservationDeposit } from "#shared/reservation-amount.ts";
import { AttendeeLedgerPanel } from "#templates/admin/attendee-ledger-panel.tsx";

/** Build the Ledger tab's merged panel for an already-loaded attendee. */
export const loadAttendeeLedgerPanel = async (
  attendeeId: number,
  baseUrl: string,
  returnUrl: string,
  activityHref: string,
): Promise<JSX.Element> => {
  const account = attendeeAccount(attendeeId);
  // The entity page already loaded this attendee, so its balance state exists.
  const state = (await getAttendeeBalanceState(attendeeId))!;

  const [status, summary, token, ledger] = await Promise.all([
    state.statusId ? getAttendeeStatus(state.statusId) : Promise.resolve(null),
    getAttendeeOrderSummary(attendeeId),
    signBalanceToken(attendeeId),
    loadAccountLedger(account),
  ]);

  const deposit = status?.is_reservation
    ? computeReservationDeposit(
        status.reservation_amount,
        summary.reservationSubtotal,
        summary.totalQuantity,
      )
    : 0;

  return AttendeeLedgerPanel({
    activityHref,
    deposit,
    fullLedgerHref: `/admin/ledger/${account.type}/${account.id}`,
    ledger,
    link: `${baseUrl}/pay/${token}`,
    // The customer pay link only works when a provider can take the payment;
    // without one, the /pay POST dead-ends, so the template withholds it.
    paymentsEnabled: isPaymentsEnabled(),
    remainingBalance: state.remainingBalance,
    returnUrl,
    status,
    summary,
  });
};
