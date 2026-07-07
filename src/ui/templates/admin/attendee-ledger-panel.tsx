/**
 * The attendee entity page's Ledger tab. One owner-only panel that opens with a
 * plain-language money summary (order price, paid so far, what's outstanding),
 * then the shared account statement — the definitive double-entry record —
 * followed by how to collect any balance and a short activity history.
 *
 * The Balance tab used to hold the summary, pay link and history; it was folded
 * in here so an owner sees the headline figures and the underlying ledger in one
 * place, with the statement as the single source of truth.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { ActivityLogEntry } from "#shared/db/activityLog.ts";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import {
  type AccountLedgerData,
  AccountStatementSection,
} from "#templates/admin/ledger.tsx";

export type AttendeeLedgerView = {
  status: AttendeeStatus | null;
  summary: OrderSummary;
  remainingBalance: number;
  deposit: number;
  link: string;
  /** Whether a payment provider is configured — the customer pay link only
   * functions when one is, so the template hides it (and says why) otherwise. */
  paymentsEnabled: boolean;
  history: ActivityLogEntry[];
  /** The attendee account's full statement + name lookup, rendered by the same
   * shared component the standalone /admin/ledger statement uses. */
  ledger: AccountLedgerData;
  /** Where the statement's edit/add links return to (this tab). */
  returnUrl: string;
  /** The standalone full-ledger statement for this account. */
  fullLedgerHref: string;
};

/** The shared prop shape for the sections that read the whole view model. */
type ViewProps = { view: AttendeeLedgerView };

/** One `<li>` money line: a bold label and its formatted amount. */
const MoneyItem = ({
  label,
  amount,
}: {
  label: string;
  amount: number;
}): JSX.Element => (
  <li>
    <strong>{label}</strong> {formatCurrency(amount)}
  </li>
);

/** The headline order summary: status and the order-price / paid / outstanding
 * figures, as a plain list a non-accountant can read at a glance. */
const OrderSummaryList = ({ view }: ViewProps): JSX.Element => {
  const { status, summary, remainingBalance, deposit } = view;
  return (
    <ul>
      <li>
        <strong>{t("attendee_balance.status_label")}</strong>{" "}
        {status ? status.name : "—"}
      </li>
      <MoneyItem
        amount={summary.fullPrice}
        label={t("attendee_balance.full_order_price_label")}
      />
      <MoneyItem
        amount={summary.depositPaid}
        label={t("attendee_balance.paid_so_far_label")}
      />
      {status?.is_reservation && (
        <MoneyItem
          amount={deposit}
          label={t("attendee_balance.reservation_deposit_label", {
            amount: status.reservation_amount,
          })}
        />
      )}
      <MoneyItem
        amount={remainingBalance}
        label={t("attendee_balance.balance_outstanding_label")}
      />
    </ul>
  );
};

/** The secure customer payment link — shown only when an online payment can
 * actually be taken (outstanding balance, reservation status, provider set). */
const PaymentLink = ({ link }: { link: string }): JSX.Element => (
  <article>
    <div class="prose">
      <h3>{t("attendee_balance.payment_link_heading")}</h3>
      <p>{t("attendee_balance.payment_link_description")}</p>
      <p>
        <input class="copyable" readonly type="text" value={link} />
      </p>
    </div>
  </article>
);

/** Why no online payment link is offered — each blocking reason spelled out, so
 * an owner knows whether to change the status, connect a provider, or just
 * collect the balance by hand. */
const OfflineCollection = ({ view }: ViewProps): JSX.Element => {
  const reasonKeys: string[] = [];
  if (!view.status?.is_reservation) {
    reasonKeys.push("attendee_balance.offline_reason_not_reservation");
  }
  if (!view.paymentsEnabled) {
    reasonKeys.push("attendee_balance.offline_reason_no_provider");
  }
  return (
    <div class="prose">
      <h3>{t("attendee_balance.collect_offline_heading")}</h3>
      <p>{t("attendee_balance.collect_offline_intro")}</p>
      <ul>
        {reasonKeys.map((key) => (
          <li>{t(key)}</li>
        ))}
      </ul>
      <p>
        {t("attendee_balance.collect_offline_reminder", {
          amount: formatCurrency(view.remainingBalance),
        })}
      </p>
    </div>
  );
};

/** How to collect the outstanding balance: the online link, the offline
 * explanation, or a fully-paid note. */
const CollectBalance = ({ view }: ViewProps): JSX.Element => {
  const { status, remainingBalance, paymentsEnabled, link } = view;
  const outstanding = remainingBalance > 0;
  // The online /pay link only works for a reservation status with a provider
  // that can take the payment; otherwise it dead-ends.
  const showPayLink =
    outstanding && !!status?.is_reservation && paymentsEnabled;
  if (!outstanding) {
    return (
      <div class="prose">
        <p>{t("attendee_balance.fully_paid_message")}</p>
      </div>
    );
  }
  return showPayLink ? (
    <PaymentLink link={link} />
  ) : (
    <OfflineCollection view={view} />
  );
};

/** The plain-English activity log for the booking. The statement above is the
 * authoritative money record; this is a convenience copy of what's happened. */
const LedgerHistory = ({
  history,
}: {
  history: ActivityLogEntry[];
}): JSX.Element => (
  <div class="prose">
    <h3>{t("attendee_balance.history_heading")}</h3>
    <p>{t("attendee_balance.history_intro")}</p>
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
  </div>
);

export const AttendeeLedgerPanel = (view: AttendeeLedgerView): JSX.Element => (
  <>
    <div class="prose">
      <h3>{t("attendee_balance.heading")}</h3>
      <OrderSummaryList view={view} />
    </div>

    <AccountStatementSection
      account={view.ledger.account}
      fullLedgerHref={view.fullLedgerHref}
      lines={view.ledger.lines}
      names={view.ledger.names}
      returnUrl={view.returnUrl}
    />

    <CollectBalance view={view} />

    <LedgerHistory history={view.history} />
  </>
);
