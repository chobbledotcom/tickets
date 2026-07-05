import { sumOf } from "#fp";
import { t } from "#i18n";
import {
  lineListPrice,
  type PricedLine,
  type PricedOrder,
} from "#shared/checkout-pricing.ts";
import { formatCurrency } from "#shared/currency.ts";

/** Prefix a line label with its quantity when more than one was taken. */
const quantityLabel = (quantity: number, name: string): string =>
  quantity > 1 ? `${quantity}× ${name}` : name;

/** One name/amount pair to render as a ticket row in the summary table. */
type TicketRow = { label: string; amount: number };

/**
 * The ticket rows to show above the modifiers.
 *
 * For a full-payment order each listing is shown at its gross list price
 * (quantity × unit price), so a discount surfaces only on its own modifier row
 * rather than being silently folded into the ticket line — otherwise the line
 * and the modifier row would double-count the same reduction. Discounts split a
 * listing into several priced lines, so those are regrouped into one row.
 *
 * For a deposit the charged amount IS the figure due now (the deposit already
 * reflects every modifier), so each priced line is shown exactly as charged.
 */
const ticketRows = (lines: PricedLine[], isDeposit: boolean): TicketRow[] =>
  isDeposit
    ? lines.map((line) => ({
        amount: line.chargedUnitAmount * line.quantity,
        label: quantityLabel(line.quantity, line.item.name),
      }))
    : [...Map.groupBy(lines, (line) => line.item.listingId).values()].map(
        (group) => ({
          amount: sumOf(lineListPrice)(group),
          label: quantityLabel(
            sumOf((line: PricedLine) => line.quantity)(group),
            group[0]!.item.name,
          ),
        }),
      );

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
 *
 * Pass `isDeposit` for a reservation so the ticket rows show the deposit charged
 * now; a full-payment order instead shows list prices before modifiers, with the
 * modifiers itemised on their own rows.
 */
export const orderSummary = (order: PricedOrder, isDeposit = false): string =>
  String(
    <div class="table-scroll">
      <table class="order-summary">
        <tbody>
          {ticketRows(order.lines, isDeposit).map((row) => (
            <SummaryRow amount={row.amount} label={row.label} />
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
