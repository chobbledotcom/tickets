/**
 * Admin route showing an attendee's reservation balance: the deposit/balance
 * breakdown, the secure customer payment link, and the payment history.
 */

import { requireOwnerOr } from "#routes/auth.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getBaseUrl } from "#routes/url.ts";
import { signBalanceToken } from "#shared/balance-link.ts";
import { isPaymentsEnabled } from "#shared/config.ts";
import { getAttendeeActivityLog } from "#shared/db/activityLog.ts";
import { getAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import {
  getAttendeeBalanceState,
  getAttendeeOrderSummary,
} from "#shared/db/attendees/balance.ts";
import { computeReservationDeposit } from "#shared/reservation-amount.ts";
import { attendeeBalancePage } from "#templates/admin/attendee-balance.tsx";

/** Handle GET /admin/attendees/:attendeeId/balance */
export const handleAttendeeBalanceGet: TypedRouteHandler<
  "GET /admin/attendees/:attendeeId/balance"
> = (request, { attendeeId }) =>
  requireOwnerOr(request, async (session) => {
    const state = await getAttendeeBalanceState(attendeeId);
    if (!state) return notFoundResponse();

    const [status, summary, history, token] = await Promise.all([
      state.statusId
        ? getAttendeeStatus(state.statusId)
        : Promise.resolve(null),
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

    return htmlResponse(
      attendeeBalancePage({
        attendeeId,
        deposit,
        history,
        link: `${getBaseUrl(request)}/pay/${token}`,
        // The customer pay link only works when a provider can take the payment;
        // without one, the /pay POST dead-ends, so the template withholds it.
        paymentsEnabled: isPaymentsEnabled(),
        remainingBalance: state.remainingBalance,
        session,
        status,
        summary,
      }),
    );
  });
