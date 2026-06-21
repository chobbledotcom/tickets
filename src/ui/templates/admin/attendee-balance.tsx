/**
 * Admin "reservation balance" panel for a single attendee: shows the deposit
 * /balance breakdown, the secure customer payment link, and the attendee's
 * payment history.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import type { AdminSession } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { BackButton } from "#templates/components/actions.tsx";
import { Layout } from "#templates/layout.tsx";

export type AttendeeBalanceView = {
  attendeeId: number;
  session: AdminSession;
  status: AttendeeStatus | null;
  summary: OrderSummary;
  remainingBalance: number;
  deposit: number;
  link: string;
  /** Whether a payment provider is configured — the customer pay link only
   * functions when one is, so the template hides it otherwise. */
  paymentsEnabled: boolean;
  history: ActivityLogEntry[];
};

export const attendeeBalancePage = (view: AttendeeBalanceView): string => {
  const { status, summary, remainingBalance, deposit, link, history } = view;
  const outstanding = remainingBalance > 0;
  // The online /pay link only works for a reservation status with a provider
  // that can take the payment; otherwise it dead-ends, so we show offline
  // collection guidance instead.
  const showPayLink =
    outstanding && !!status?.is_reservation && view.paymentsEnabled;
  return String(
    <Layout title={t("attendee_balance.page_title")}>
      <AdminNav active="/admin/attendees" session={view.session} />
      <p>
        <BackButton href={`/admin/attendees/${view.attendeeId}`}>
          {t("attendee_balance.back_to_attendee")}
        </BackButton>
      </p>
      <div class="prose">
        <h1>{t("attendee_balance.heading")}</h1>
        <p>
          <strong>{t("attendee_balance.status_label")}</strong>{" "}
          {status ? status.name : "—"}
        </p>
        <p>
          <strong>{t("attendee_balance.full_order_price_label")}</strong>{" "}
          {formatCurrency(summary.fullPrice)}
        </p>
        <p>
          <strong>{t("attendee_balance.paid_so_far_label")}</strong>{" "}
          {formatCurrency(summary.depositPaid)}
        </p>
        {status?.is_reservation && (
          <p>
            <strong>
              {t("attendee_balance.reservation_deposit_label", {
                amount: status.reservation_amount,
              })}
            </strong>{" "}
            {formatCurrency(deposit)}
          </p>
        )}
        <p>
          <strong>{t("attendee_balance.balance_outstanding_label")}</strong>{" "}
          {formatCurrency(remainingBalance)}
        </p>
      </div>

      {!outstanding ? (
        <p>{t("attendee_balance.fully_paid_message")}</p>
      ) : showPayLink ? (
        <article>
          <div class="prose">
            <h2>{t("attendee_balance.payment_link_heading")}</h2>
            <p>{t("attendee_balance.payment_link_description")}</p>
            <p>
              <input class="copyable" readonly type="text" value={link} />
            </p>
          </div>
        </article>
      ) : (
        <p>{t("attendee_balance.offline_balance_message")}</p>
      )}

      <h2>{t("attendee_balance.history_heading")}</h2>
      {history.length === 0 ? (
        <p>{t("attendee_balance.no_history_message")}</p>
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
