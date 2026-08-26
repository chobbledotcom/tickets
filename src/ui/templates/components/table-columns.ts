/**
 * Column-width schema, TS side. The widths and alignment live once in the
 * `$column-kinds` map in `src/ui/static/style.scss`, which generates a
 * `.col-<kind>` class per kind. {@link ColumnKind} mirrors those names, so it
 * must be kept in step with the SCSS map.
 *
 * Every kind is a narrow shrink-to-content column, so a kind only varies the
 * alignment and can never stretch a column wide.
 */

/** A recurring kind of table column with a codified width + alignment. */
export type ColumnKind = "reorder" | "amount" | "quantity" | "actions";

/** The CSS class for a column {@link ColumnKind} (e.g. `colClass("amount")` →
 * `"col-amount"`), for use on the column's <th> and every matching <td>. */
export const colClass = (kind: ColumnKind): string => `col-${kind}`;
