/**
 * Public "pay your remaining balance" page. PII-free: it recaps the booked
 * products and the amount due (read from plaintext data), never the customer's
 * personal details.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
/* jscpd:ignore-start */
import type { LineItem } from "#shared/line-item.ts";
import { defineTable } from "#shared/tables/definition.ts";
/* jscpd:ignore-end */
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { messagePublicPage, prosePage } from "./prose-page.tsx";
import { AmountLine } from "./shared.tsx";

/** What the recap shows: the buyer's lines beside the order's money. */
type BalanceRecap = {
  depositPaid: number;
  fullPrice: number;
  lines: LineItem[];
};

const orderSummaryTable = defineTable<LineItem>([
  {
    cell: (line) => line.name,
    header: () => t("public_balance.item"),
    key: "item",
  },
  {
    cell: (line) => line.quantity,
    class: "quantity",
    header: () => t("common.qty"),
    key: "quantity",
  },
]);

/** Recap + pay form for an outstanding balance. */
export const balancePaymentPage = (
  token: string,
  amount: number,
  recap: BalanceRecap,
): string =>
  prosePage(
    t("public_balance.pay_your_balance"),
    t("public_balance.pay_your_balance"),
  )(
    <p>{t("public_balance.booking_summary")}</p>,
    <>
      {renderTable(orderSummaryTable, recap.lines)}
      <AmountLine
        amount={recap.fullPrice}
        label={`${t("public_balance.full_order_price")}:`}
      />
      <AmountLine
        amount={recap.depositPaid}
        label={`${t("public_balance.already_paid")}:`}
      />
      <AmountLine
        amount={amount}
        label={`${t("public_balance.balance_due")}:`}
      />
      <SaveForm
        action={`/pay/${token}`}
        submitLabel={t("public_balance.pay_amount_now", {
          amount: formatCurrency(amount),
        })}
      />
    </>,
  );

/** Shown when the link is valid but there is nothing left to pay. */
export const balanceSettledPage = messagePublicPage(
  "public_balance.nothing_to_pay",
  "public_balance.nothing_to_pay",
  "public_balance.balance_settled",
);

/** Shown when the link is invalid or expired. */
export const balanceInvalidPage = messagePublicPage(
  "public_balance.link_not_valid",
  "public_balance.payment_link_invalid",
  "public_balance.link_expired_or_mistyped",
);

/** Shown when the link is valid but the booking has no bookable (quantity > 0)
 * line to pay into. This is an honest message rather than "link not valid". */
export const balanceNoItemsPage = messagePublicPage(
  "public_balance.no_tickets_title",
  "public_balance.no_tickets_heading",
  "public_balance.no_tickets_message",
);
