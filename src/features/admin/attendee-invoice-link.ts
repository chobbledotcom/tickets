/**
 * The one rule for offering to invoice a booking. The attendee page's Actions
 * tab and its Money tab read it, and the create route refuses on the same
 * facts. A link therefore never promises a form that will refuse it.
 */

import type { AttendeeBalanceState } from "#db/attendees/balance.ts";
import { settings } from "#db/settings.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { isReadOnly } from "#shared/env.ts";

/** Where the create-invoice page is for one booking. */
export const invoiceCreatePath = (attendeeId: number): string =>
  `${adminPath("invoiceNew", {})}?attendee=${attendeeId}`;

/** Whether the site offers an invoice for a booking, from facts the caller
 *  loaded. The Invoices switch is on, the site can be written to, the booking
 *  still owes money, and no new invoice covers it. A null balance means the
 *  attendee holds no booking balance. */
export const canCreateInvoice = ({
  balance,
  hasNewInvoice,
}: {
  balance: AttendeeBalanceState | null;
  hasNewInvoice: boolean;
}): boolean =>
  settings.features.invoices &&
  !isReadOnly() &&
  !hasNewInvoice &&
  balance !== null &&
  balance.remainingBalance > 0;
