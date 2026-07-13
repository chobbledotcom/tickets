import { formatCurrency } from "#shared/currency.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";

/** A bold label followed by a formatted money amount — the shared inside of the
 *  order-total money lines. The public balance page wraps it in a `<p>`; the
 *  admin ledger summary wraps it in an `<li>`. */
export const LabelledAmount = ({
  label,
  amount,
}: {
  label: Child;
  amount: number;
}): JSX.Element => (
  <>
    <strong>{label}</strong> {formatCurrency(amount)}
  </>
);
