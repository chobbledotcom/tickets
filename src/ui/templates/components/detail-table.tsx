/**
 * A `<div class="table-scroll"><table class="listing-details-table"><tbody>`
 * shell for the read-only key/value summary tables on admin detail pages
 * (per-user, per-API-key, per-listing, per-group, per-entity).
 *
 * Shared {@link DetailRow} data is rendered through {@link LabelledRow}; pages
 * can also pass custom JSX rows as children when their table needs different
 * cells. The custom rows come first, followed by the shared rows.
 */

/* jscpd:ignore-start */
import type { Child } from "#jsx/jsx-runtime.ts";
import type { DetailRow } from "#templates/admin/detail-rows.tsx";
import { LabelledRow } from "#templates/components/labelled-row.tsx";
/* jscpd:ignore-end */

export type DetailTableProps = {
  rows?: DetailRow[];
  children?: Child;
};

export const DetailTable = ({
  rows = [],
  children,
}: DetailTableProps): JSX.Element => (
  <div class="table-scroll">
    <table class="listing-details-table">
      <tbody>
        {children}
        {rows.map((row) => (
          <LabelledRow label={row.key}>{row.value}</LabelledRow>
        ))}
      </tbody>
    </table>
  </div>
);
