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
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import {
  type AccountLedgerData,
  AccountStatementSection,
} from "#templates/admin/ledger.tsx";
import { PageLayout } from "#templates/components/page-layout.tsx";

export type AttendeeLedgerView = {
  status: AttendeeStatus | null;
  summary: OrderSummary;
  remainingBalance: number;
  deposit: number;
  link: string;
  /** Whether a payment provider is configured — the customer pay link only
   * functions when one is, so the template hides it (and says why) otherwise. */
  paymentsEnabled: boolean;
  /** The attendee account's full statement + name lookup, rendered by the same
   * shared component the standalone /admin/ledger statement uses. */
  ledger: AccountLedgerData;
  /** Where the statement's edit/add links return to (this tab). */
  returnUrl: string;
  /** The standalone full-ledger statement for this account. */
  fullLedgerHref: string;
  /** The attendee's Activity tab — where the full plain-English log lives. */
  activityHref: string;
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
 * actually be taken (outstanding balance, provider set, a real line to pay). */
const PaymentLink = ({ link }: { link: string }): JSX.Element => (
  <article>
    <div class="prose">
      <h3>{t("attendee_balance.payment_link_heading")}</h3>
      <p>{t("attendee_balance.payment_link_description")}</p>
      <p>
        <input class="copyable" readonly type="text" value={link} />
      </p>
      {/* Only quantity > 0 lines are charged, so a mixed booking (some real,
          some no-quantity lines) collects less than the full balance online. */}
      <p class="muted small">{t("attendee_balance.quantity_note")}</p>
    </div>
  </article>
);

/** Why no online payment link is offered — each blocking reason spelled out, so
 * an owner knows whether to connect a provider or just collect the balance by
 * hand. */
const OfflineCollection = ({ view }: ViewProps): JSX.Element => {
  const reasonKeys: string[] = [];
  if (!view.paymentsEnabled) {
    reasonKeys.push("attendee_balance.offline_reason_no_provider");
  }
  // A no-quantity-only order has nothing to pay into, so the public /pay page
  // refuses it — don't offer a link that would dead-end.
  if (view.summary.lines.length === 0) {
    reasonKeys.push("attendee_balance.offline_reason_no_lines");
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
  const { summary, remainingBalance, paymentsEnabled, link } = view;
  const outstanding = remainingBalance > 0;
  // The online /pay link only works with a provider that can take the payment
  // AND at least one real (quantity > 0) line to pay into; otherwise it
  // dead-ends exactly as the public /pay page refuses it.
  const showPayLink =
    outstanding && paymentsEnabled && summary.lines.length > 0;
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

/** A short note that the statement above is the authoritative money record,
 * pointing to the Activity tab for the full plain-English log. */
const LedgerHistory = ({
  activityHref,
}: {
  activityHref: string;
}): JSX.Element => (
  <div class="prose">
    <h3>{t("attendee_balance.history_heading")}</h3>
    <p>{t("attendee_balance.history_intro")}</p>
    <p>
      <a href={activityHref}>{t("attendee_balance.history_activity_link")}</a>
    </p>
  </div>
);

export const AttendeeLedgerPanel = (view: AttendeeLedgerView): JSX.Element => (
  <PageLayout>
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

    <LedgerHistory activityHref={view.activityHref} />
  </PageLayout>
);
