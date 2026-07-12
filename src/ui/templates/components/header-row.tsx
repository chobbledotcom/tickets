/**
 * A table row that opens with a `scope="row"` header cell, followed by the
 * caller's own body cells. Shared by the key/value detail tables and the
 * attendee-merge decision tables, which all start a row this same way.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

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
