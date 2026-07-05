/**
 * A `<div class="table-scroll"><table class="listing-details-table"><tbody>`
 * shell for the read-only key/value summary tables on admin detail pages
 * (per-user, per-API-key, per-listing, per-group, per-entity).
 *
 * Several pages hand-wrote this shell with either pre-rendered `<tr>` rows (via
 * {@link renderDetailRows} + `<Raw>`) or inline JSX `<tr><th>…</th><td>…</td></tr>`
 * rows. Both shapes go through this one component now so the scroll wrapper,
 * table class, and tbody structure can't drift per page.
 *
 * Pass `rows` ({@link DetailRow}[]) for the shared detail-row builder, or
 * `children` (one `<tr>` per row) for hand-written JSX rows.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type DetailRow,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";

export type DetailTableProps = {
  /** Detail rows rendered through {@link renderDetailRows} as a HTML string
   *  of `<tr><th>key</th><td>value</td></tr>` rows. */
  rows?: DetailRow[];
  /** Hand-written `<tr>` rows — use when a row's value is JSX (links,
   *  conditional content) rather than a plain string. */
  children?: Child;
};

export const DetailTable = ({
  rows,
  children,
}: DetailTableProps): JSX.Element => (
  <div class="table-scroll">
    <table class="listing-details-table">
      <tbody>
        {rows !== undefined ? <Raw html={renderDetailRows(rows)} /> : children}
      </tbody>
    </table>
  </div>
);
