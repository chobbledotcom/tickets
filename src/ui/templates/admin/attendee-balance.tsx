/**
 * Admin "reservation balance" panel for a single attendee: shows the deposit
 * /balance breakdown, the secure customer payment link, and the attendee's
 * payment history.
 */

import { formatCurrency } from "#shared/currency.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { Layout } from "#templates/layout.tsx";

export type AttendeeBalanceView = {
  attendeeId: number;
  session: AdminSession;
  status: AttendeeStatus | null;
  summary: OrderSummary;
  remainingBalance: number;
  deposit: number;
  link: string;
  history: ActivityLogEntry[];
};

export const attendeeBalancePage = (view: AttendeeBalanceView): string => {
  const { status, summary, remainingBalance, deposit, link, history } = view;
  const outstanding = remainingBalance > 0;
  return String(
    <Layout title="Attendee balance">
      <AdminNav active="/admin/" session={view.session} />
      <p>
        <a href={`/admin/attendees/${view.attendeeId}`}>← Back to attendee</a>
      </p>
      <h1>Reservation balance</h1>

      <p>
        <strong>Status:</strong> {status ? status.name : "—"}
      </p>
      <p>
        <strong>Full order price:</strong> {formatCurrency(summary.fullPrice)}
      </p>
      <p>
        <strong>Paid so far:</strong> {formatCurrency(summary.depositPaid)}
      </p>
      {status?.is_reservation && (
        <p>
          <strong>Reservation deposit ({status.reservation_amount}):</strong>{" "}
          {formatCurrency(deposit)}
        </p>
      )}
      <p>
        <strong>Balance outstanding:</strong> {formatCurrency(remainingBalance)}
      </p>

      {outstanding ? (
        <article>
          <h2>Customer payment link</h2>
          <p>
            Send this secure link to the customer to collect the balance. It
            contains no personal details and is valid for about 90 days;
            generate a fresh one any time by reloading this page.
          </p>
          <p>
            <input class="copyable" readonly type="text" value={link} />
          </p>
        </article>
      ) : (
        <p>This booking is fully paid.</p>
      )}

      <h2>History</h2>
      {history.length === 0 ? (
        <p>No payment history recorded.</p>
      ) : (
        <ul>
          {history.map((entry) => (
            <li>
              {entry.created.slice(0, 10)} — {entry.message}
            </li>
          ))}
        </ul>
      )}
    </Layout>,
  );
};
