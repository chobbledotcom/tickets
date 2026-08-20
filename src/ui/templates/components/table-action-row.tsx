import type { Child } from "#jsx/jsx-runtime.ts";

/** A row of table action buttons or links, wrapped in the shared styling that
 *  sits them under a table (the ledger scope picker, view toggle, and date
 *  jumps all use it). */
export const TableActionRow = ({
  children,
}: {
  children: Child;
}): JSX.Element => <p class="table-action-btns">{children}</p>;
