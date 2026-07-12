import { formatSignedCurrency } from "#shared/currency.ts";
import { ActionButton } from "#templates/components/actions.tsx";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import { colClass } from "#templates/components/table-columns.ts";

export type MoneySummaryRow = {
  amount: number;
  label: string;
  signed?: boolean;
  subtotal?: boolean;
};

const SummaryRow = ({
  amount,
  label,
  signed = true,
  subtotal = false,
}: MoneySummaryRow): JSX.Element => {
  const shown = formatSignedCurrency(amount, signed);
  return (
    <tr class={subtotal ? "breakdown-subtotal" : undefined}>
      <th>{subtotal ? <strong>{label}</strong> : label}</th>
      <td class={colClass("amount")}>
        {subtotal ? <strong>{shown}</strong> : shown}
      </td>
    </tr>
  );
};

/** A compact, shared explanation of value added, value removed, and the result. */
export const MoneySummary = ({
  ledgerHref,
  ledgerLabel,
  note,
  rows,
  title,
}: {
  ledgerHref?: string | undefined;
  ledgerLabel: string;
  note?: string | undefined;
  rows: MoneySummaryRow[];
  title: string;
}): JSX.Element => (
  <SectionFieldset className="listing-section" legend={title}>
    <div class="table-scroll">
      <table class="listing-breakdown-table">
        <tbody>{rows.map(SummaryRow)}</tbody>
      </table>
    </div>
    {note && (
      <p>
        <small>{note}</small>
      </p>
    )}
    {ledgerHref && (
      <p class="actions">
        <ActionButton href={ledgerHref}>{ledgerLabel}</ActionButton>
      </p>
    )}
  </SectionFieldset>
);
