/**
 * Admin "reservation balance" panel for a single attendee: shows the deposit
 * /balance breakdown, the secure customer payment link, and the attendee's
 * payment history. Rendered as the attendee entity page's Balance tab.
 */

import { t } from "#i18n";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import { AmountLine } from "#templates/public/shared.tsx";

export type AttendeeBalanceView = {
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

export const AttendeeBalancePanel = (
  view: AttendeeBalanceView,
): JSX.Element => {
  const { status, summary, remainingBalance, deposit, link, history } = view;
  const outstanding = remainingBalance > 0;
  // Only quantity > 0 lines can be paid into; the summary already excludes the
  // no-quantity sentinels, so an empty list means there is nothing bookable.
  const hasRealLine = summary.lines.length > 0;
  // The online /pay link only works for a reservation status with a provider
  // that can take the payment AND a real line to pay into; otherwise it
  // dead-ends, so we show guidance instead.
  const readyToPay =
    outstanding && !!status?.is_reservation && view.paymentsEnabled;
  const showPayLink = readyToPay && hasRealLine;
  // A reservation that could otherwise be paid online but whose every line is
  // no-quantity: warn the owner rather than hand them a link that dead-ends.
  const blockedNoLiveTicket = readyToPay && !hasRealLine;
  return (
    <>
      <div class="prose">
        <h3>{t("attendee_balance.heading")}</h3>
        <p>
          <strong>{t("attendee_balance.status_label")}</strong>{" "}
          {status ? status.name : "—"}
        </p>
        <AmountLine
          amount={summary.fullPrice}
          label={t("attendee_balance.full_order_price_label")}
        />
        <AmountLine
          amount={summary.depositPaid}
          label={t("attendee_balance.paid_so_far_label")}
        />
        {status?.is_reservation && (
          <AmountLine
            amount={deposit}
            label={t("attendee_balance.reservation_deposit_label", {
              amount: status.reservation_amount,
            })}
          />
        )}
        <AmountLine
          amount={remainingBalance}
          label={t("attendee_balance.balance_outstanding_label")}
        />
      </div>

      {!outstanding ? (
        <p>{t("attendee_balance.fully_paid_message")}</p>
      ) : showPayLink ? (
        <article>
          <div class="prose">
            <h3>{t("attendee_balance.payment_link_heading")}</h3>
            <p>{t("attendee_balance.payment_link_description")}</p>
            <p>
              <input class="copyable" readonly type="text" value={link} />
            </p>
            <p class="muted small">{t("attendee_balance.quantity_note")}</p>
          </div>
        </article>
      ) : blockedNoLiveTicket ? (
        <p>{t("attendee_balance.no_live_ticket_message")}</p>
      ) : (
        <p>{t("attendee_balance.offline_balance_message")}</p>
      )}

      <h3>{t("attendee_balance.history_heading")}</h3>
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
    </>
  );
};
