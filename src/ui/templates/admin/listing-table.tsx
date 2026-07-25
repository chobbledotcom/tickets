/**
 * The admin listings tables: a thin composition layer over the shared
 * `listingTable` definition. The scrolling `<div class="table-scroll">`
 * shell, the CSV-export footer, and the page block that wraps the table
 * live here; the actual headers, cells, and column order come from
 * {@link listingTable} and {@link editorListingTable} in
 * `#shared/tables/listing-table.tsx`.
 *
 * Two entry points, in order of completeness:
 *   - `ListingsTableBlock`  — page block + optional header/CSV footer (dashboard, listings index)
 *   - `renderListingsTableSection` — the table with its scroll wrapper only (group overview)
 */

import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  editorListingTable,
  listingTable,
} from "#shared/tables/listing-table.tsx";
import type { ListingWithCount } from "#shared/types.ts";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { renderTable } from "#templates/components/table.tsx";

export { editorListingTable, listingTable };

/** The staff listing table by default; editors see `editorListingTable`
 *  (a money-free, edit-linked subset). */
export type ListingTableVariant =
  | typeof listingTable
  | typeof editorListingTable;

/** The ListingsTable family's shared input: the rows, the parsed column
 *  layout, and an optional variant override. */
export type ListingTableArgs = {
  /** The listings to render rows for. */
  listings: ListingWithCount[];
  /** The column order to honour (a parsed layout's `columnKeys`). Defaults
   *  to the variant's own `defaultColumnKeys` when omitted. */
  readonly columnKeys?: readonly string[] | undefined;
  /** Liquid filter expressions per column key (a parsed layout's `filters`). */
  readonly filters?: ReadonlyMap<string, string> | undefined;
  /** Override the staff listing table with a different variant. Editors see
   *  a money-free, edit-linked subset via `editorListingTable`. */
  readonly table?: ListingTableVariant | undefined;
};

const resolveTable = (table: ListingTableVariant | undefined) =>
  table ?? listingTable;

/** Render the listings table (rows + header + scroll wrapper). Shared by
 *  the dashboard, the listings index, and the group overview — each of
 *  which composes its own page-level shell around this table. */
export const renderListingsTableSection = (
  args: ListingTableArgs & { emptyText: string },
): JSX.Element => {
  const table = resolveTable(args.table);
  return renderTable(table, args.listings, {
    columnKeys: args.columnKeys ?? table.defaultColumnKeys,
    empty: args.emptyText,
    filters: args.filters,
  });
};

/** A listings table with an optional filter row above it. When `csvExport`
 *  is set, a CSV-export footer is shown below in the same block. Shared by
 *  the dashboard (active-only table, no export) and the listings index
 *  (active + deactivated, exports all). */
export const ListingsTableBlock = (
  args: ListingTableArgs & {
    csvExport?: boolean | undefined;
    csvHref?: string | undefined;
    headerHtml?: string | undefined;
  },
): JSX.Element => (
  <PageBlock>
    {args.headerHtml !== undefined && <Raw html={args.headerHtml} />}
    {renderListingsTableSection({
      columnKeys: args.columnKeys,
      emptyText: t("admin.dashboard.no_listings"),
      filters: args.filters,
      listings: args.listings,
      table: args.table,
    })}
    {args.csvExport && (
      <div class="table-actions">
        <a href={args.csvHref ?? "/admin/listings/csv"}>
          {t("listings_table.export_csv")}
        </a>
      </div>
    )}
  </PageBlock>
);
