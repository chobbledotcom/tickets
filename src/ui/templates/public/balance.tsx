/**
 * Public "pay your remaining balance" page. PII-free: it recaps the booked
 * products and the amount due (read from plaintext data), never the customer's
 * personal details.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import { DataTable } from "#templates/components/data-table.tsx";
import { SubmitForm } from "#templates/components/submit-form.tsx";
import { AmountLine, prosePage, simplePublicPage } from "./shared.tsx";

/** Recap + pay form for an outstanding balance. */
export const balancePaymentPage = (
  token: string,
  amount: number,
  summary: OrderSummary,
): string =>
  prosePage(
    t("public_balance.pay_your_balance"),
    t("public_balance.pay_your_balance"),
  )(
    <p>{t("public_balance.booking_summary")}</p>,
    <>
      <DataTable
        columns={[
          { header: t("public_balance.item") },
          { class: "quantity", header: t("common.qty") },
        ]}
        rows={summary.lines.map((line) => [line.name, line.quantity])}
      />
      <AmountLine
        amount={summary.fullPrice}
        label={`${t("public_balance.full_order_price")}:`}
      />
      <AmountLine
        amount={summary.depositPaid}
        label={`${t("public_balance.already_paid")}:`}
      />
      <AmountLine
        amount={amount}
        label={`${t("public_balance.balance_due")}:`}
      />
      <SubmitForm
        action={`/pay/${token}`}
        icon="save"
        submitLabel={t("public_balance.pay_amount_now", {
          amount: formatCurrency(amount),
        })}
      />
    </>,
  );

/** Shown when the link is valid but there is nothing left to pay. */
export const balanceSettledPage = (): string =>
  simplePublicPage(
    t("public_balance.nothing_to_pay"),
    t("public_balance.nothing_to_pay"),
  )(<p>{t("public_balance.balance_settled")}</p>);

/** Shown when the link is invalid or expired. */
export const balanceInvalidPage = (): string =>
  simplePublicPage(
    t("public_balance.link_not_valid"),
    t("public_balance.payment_link_invalid"),
  )(<p>{t("public_balance.link_expired_or_mistyped")}</p>);

/** Shown when the link is valid but the booking has no bookable (quantity > 0)
 * line to pay into — an honest message rather than "link not valid". */
export const balanceNoItemsPage = (): string =>
  simplePublicPage(
    t("public_balance.no_tickets_title"),
    t("public_balance.no_tickets_heading"),
  )(<p>{t("public_balance.no_tickets_message")}</p>);
