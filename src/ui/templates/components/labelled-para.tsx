/**
 * A short list of "bold label, then value" paragraphs — the
 * `<p><strong>{label}</strong> {value}</p>` shape used by the payment page
 * summary and the admin attendee-details block. Modelling the lines as data
 * (a `{ label, value }[]`) keeps the paragraph markup in one place so the two
 * pages can't drift.
 */

import type { Child } from "#jsx/jsx-runtime.ts";
import { mappedItems } from "#templates/components/item-list.tsx";

/** One "bold label, then value" line. */
export type LabelledLine = {
  label: Child;
  value: Child;
};

export const LabelledParas = ({
  items,
}: {
  items: LabelledLine[];
}): JSX.Element =>
  mappedItems(items, (item) => (
    <p>
      <strong>{item.label}</strong> {item.value}
    </p>
  ));
