/**
 * Typed, keyed table column: the one declaration every rectangular admin
 * table renders from.
 *
 * The key is the column's identity — it stays stable across renders, drives
 * the configurable layout keys (e.g. the listing/attendee "column order"
 * Liquid template), and labels the column in the guide reference table.
 *
 * The cell renderer takes a row and the per-table context (default `void`),
 * so an ordinary column with no context can ignore both. Cells return JSX
 * children — `Child` — never raw HTML strings, so escaping is automatic and
 * the old `isHtml` flag and `escapeHtml` trust protocol are gone.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import type { ReorderProps } from "#templates/components/reorder.tsx";
import type { ColumnKind } from "#templates/components/table-columns.ts";

export type { ColumnKind };

/** Attributes a column's cell can attach to its <td>: the values a caller
 *  may need (data-* attributes for JS hooks, simple class overrides). The
 *  `class` key overlaps with the column-level `class` kind, so the renderer
 *  merges both into one class string. */
export type CellAttrs = Record<string, string | number | boolean | undefined>;

/** One column in a typed table: its key, header, cell renderer, optional
 *  column-kind class, optional per-cell attributes, and the optional pieces
 *  that drive configurable layouts (rawValue) and the guide reference
 *  table (label + description). */
export type TableColumn<TRow, TContext = void> = {
  /** Stable identifier for this column. The same key appears in configurable
   *  layout templates (`{{key}}`) and in the guide reference table. */
  readonly key: string;
  /** The <th> content, or a function that reads translated copy at render time. */
  readonly header: Child | (() => Child);
  /** Render the <td> inner content for one row. The context is the per-table
   *  `TContext` (default `void`); an ordinary column with no context can
   *  ignore every parameter after `row`. */
  readonly cell: (
    row: TRow,
    ctx: TContext,
    index: number,
    rows: readonly TRow[],
  ) => Child;
  /** A column-kind class (e.g. `"amount"`, `"quantity"`, `"reorder"`,
   *  `"actions"`) applied to both this column's <th> and every <td> in it.
   *  Use for the codified width/alignment kinds mirrored in
   *  `$column-kinds` in `style.scss`. */
  readonly class?: ColumnKind;
  /** A free-form class applied to every <td> in this column (e.g.
   *  `"cell-description"` for the listing description's truncation,
   *  `"actions-col"` for the attendee status cell). Note this does NOT set
   *  the <th>; use `headerClassName` for that. */
  readonly className?: string;
  /** A free-form class applied to this column's <th> only. Use when the
   *  header and body cells need different classes (e.g. the attendee name
   *  column's empty header but action-classed body cells). */
  readonly headerClassName?: string;
  /** Per-cell attributes (e.g. `{"data-id": row.id}`). Useful for tables
   *  whose rows carry data attributes consumed by client-side JS hooks
   *  (the duplicate-preview table). The `class` key, if set here, merges
   *  with `class`, `className`, and `headerClassName` for that one cell. */
  readonly cellAttrs?: (row: TRow, ctx: TContext) => CellAttrs;
  /** Return the raw, Liquid-friendly value for this column. When the user
   *  applies a Liquid filter (e.g. `{{created | date: "%B"}}`), the filter
   *  runs against this value instead of the cell renderer's output. */
  readonly rawValue?: (row: TRow, ctx: TContext) => unknown;
  /** Short label for the column-reference table shown in the guide. A function
   *  reads translated copy only when the guide is rendered. */
  readonly label?: string | (() => string);
  /** Description for the guide, either ready text or translated at render time. */
  readonly description?: string | (() => string);
};

/** The standard up/down reorder-arrows column declaration: prepended to a
 *  table when the operator can re-order rows (holidays, attributes,
 *  questions, site-page items). Hidden entirely in read-only mode. */
export type ReorderColumnOptions<TRow> = {
  readonly action: (row: TRow) => ReorderProps["action"];
  readonly header: Child;
  readonly titles?: { readonly down: string; readonly up: string };
};
