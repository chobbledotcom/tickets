/**
 * Column-width schema (TS side).
 *
 * The widths and alignment for recurring kinds of table column are codified
 * once in `src/ui/static/style.scss` (the `$column-kinds` map, which generates
 * a `.col-<kind>` class per kind). This module mirrors the kind names so
 * templates reference them type-safely instead of hand-writing class strings —
 * keep {@link ColumnKind} in step with the SCSS map.
 *
 * Every kind is a narrow, shrink-to-content column (`width: 1%` + nowrap), so
 * these columns can never be stretched wide; the kind only varies the
 * alignment. Reach for one of these on a <th>/<td> whenever a table has an
 * up/down reorder-arrows column, a money figure, an integer quantity, or a
 * trailing edit/delete action link.
 */

/** A recurring kind of table column with a codified width + alignment. */
export type ColumnKind = "reorder" | "amount" | "quantity" | "actions";

/** The CSS class for a column {@link ColumnKind} (e.g. `colClass("amount")` →
 * `"col-amount"`), for use on the column's <th> and every matching <td>. */
export const colClass = (kind: ColumnKind): string => `col-${kind}`;
