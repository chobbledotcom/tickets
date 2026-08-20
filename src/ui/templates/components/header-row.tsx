/**
 * A table row that opens with a `scope="row"` header cell, followed by the
 * caller's own body cells. Shared by the key/value detail tables and the
 * attendee-merge decision tables, which all start a row this same way.
 */

import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import { colClass } from "#templates/components/table-columns.ts";

/** A right-aligned quantity/count column header (`col-quantity`), labelled by a
 *  message key. Shared by the admin collection tables (attributes, questions,
 *  attendees) whose narrow numeric columns all use this same cell. */
export const quantityHeader = (labelKey: string): JSX.Element => (
  <th class={colClass("quantity")}>{t(labelKey)}</th>
);

export const HeaderRow = ({
  header,
  children,
}: {
  header: Child;
  children: Child;
}): JSX.Element => (
  <tr>
    <th scope="row">{header}</th>
    {children}
  </tr>
);
