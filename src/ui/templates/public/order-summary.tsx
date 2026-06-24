import { t } from "#i18n";
import type { PricedOrder } from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";

/** Prefix a line label with its quantity when more than one was taken. */
const quantityLabel = (quantity: number, name: string): string =>
  quantity > 1 ? `${quantity}× ${name}` : name;

/** A single name/amount row in the order-summary table. */
const SummaryRow = ({
  label,
  amount,
  total,
}: {
  label: string;
  amount: number;
  total?: boolean;
}): JSX.Element => (
  <tr class={total ? "order-summary-total" : undefined}>
    <th scope="row">{label}</th>
    <td>{formatCurrency(amount)}</td>
  </tr>
);

/**
 * Render a fully-priced order as a compact summary table. Returned as a bare
 * HTML fragment so the booking form's running-total script can drop it inline,
 * and so the no-JS `target="_blank"` fallback shows the same breakdown.
 */
export const orderSummary = (order: PricedOrder): string =>
  String(
    <div class="table-scroll">
      <table class="order-summary">
        <tbody>
          {order.lines.map((line) => (
            <SummaryRow
              amount={line.chargedUnitAmount * line.quantity}
              label={quantityLabel(line.quantity, line.item.name)}
            />
          ))}
          {order.extras.map((extra) => (
            <SummaryRow
              amount={extra.amount * extra.quantity}
              label={quantityLabel(extra.quantity, extra.name)}
            />
          ))}
          {order.modifierApplications
            .filter((app) => app.delta < 0)
            .map((app) => (
              <SummaryRow amount={app.delta} label={app.name} />
            ))}
        </tbody>
        <tfoot>
          <SummaryRow
            amount={order.total}
            label={t("public.ticket.order_total")}
            total
          />
        </tfoot>
      </table>
    </div>,
  );

/**
 * Render a short message for when the order can't be totalled yet — nothing
 * selected, a validation gate unmet, or an expired form token.
 */
export const orderSummaryMessage = (message: string): string =>
  String(<p class="order-summary-message">{message}</p>);
