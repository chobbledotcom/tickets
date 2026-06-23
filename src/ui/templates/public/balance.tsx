/**
 * Public "pay your remaining balance" page. PII-free: it recaps the booked
 * products and the amount due (read from plaintext data), never the customer's
 * personal details.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import type { OrderSummary } from "#shared/db/attendees/balance.ts";
import { CsrfForm } from "#shared/forms.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { colClass } from "#templates/components/table-columns.ts";
import { Layout } from "#templates/layout.tsx";

/** Recap + pay form for an outstanding balance. */
export const balancePaymentPage = (
  token: string,
  amount: number,
  summary: OrderSummary,
): string =>
  String(
    <Layout title={t("public_balance.pay_your_balance")}>
      <div class="prose">
        <h1>{t("public_balance.pay_your_balance")}</h1>
        <p>{t("public_balance.booking_summary")}</p>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("public_balance.item")}</th>
              <th class={colClass("quantity")}>{t("common.qty")}</th>
            </tr>
          </thead>
          <tbody>
            {summary.lines.map((line) => (
              <tr>
                <td>{line.name}</td>
                <td class={colClass("quantity")}>{line.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <strong>{t("public_balance.full_order_price")}:</strong>{" "}
        {formatCurrency(summary.fullPrice)}
      </p>
      <p>
        <strong>{t("public_balance.already_paid")}:</strong>{" "}
        {formatCurrency(summary.depositPaid)}
      </p>
      <p>
        <strong>{t("public_balance.balance_due")}:</strong>{" "}
        {formatCurrency(amount)}
      </p>
      <CsrfForm action={`/pay/${token}`}>
        <SubmitButton icon="save">
          {t("public_balance.pay_amount_now", {
            amount: formatCurrency(amount),
          })}
        </SubmitButton>
      </CsrfForm>
    </Layout>,
  );

/** Shown when the link is valid but there is nothing left to pay. */
export const balanceSettledPage = (): string =>
  String(
    <Layout title={t("public_balance.nothing_to_pay")}>
      <div class="prose">
        <h1>{t("public_balance.nothing_to_pay")}</h1>
        <p>{t("public_balance.balance_settled")}</p>
      </div>
    </Layout>,
  );

/** Shown when the link is invalid or expired. */
export const balanceInvalidPage = (): string =>
  String(
    <Layout title={t("public_balance.link_not_valid")}>
      <div class="prose">
        <h1>{t("public_balance.payment_link_invalid")}</h1>
        <p>{t("public_balance.link_expired_or_mistyped")}</p>
      </div>
    </Layout>,
  );
