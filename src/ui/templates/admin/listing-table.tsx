/**
 * The admin listings tables: ordered columns, rows, and the scrolling table
 * block shared by the dashboard, the listings index, and the group detail
 * page.
 */

/* jscpd:ignore-start */
import { joinStrings, map, pipe } from "#fp";
import { t } from "#i18n";
import {
  type ColumnGenerators,
  getHeaderText,
  renderCells,
} from "#shared/column-order.ts";
import { LISTING_TABLE_COLUMNS } from "#shared/columns/listing-columns.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { TableScroll } from "#templates/components/table-scroll.tsx";
import { escapeHtml } from "#templates/layout.tsx";

/* jscpd:ignore-end */

/** The ordered column layout a listings table (or single row) renders from. */
type ListingColumnArgs = {
  columnKeys: readonly string[];
  filters: ReadonlyMap<string, string>;
  columns?: ColumnGenerators<ListingWithCount>;
};

/** Render a single listing table row using ordered column keys. `columns`
 * defaults to the full staff column set; the editor variant passes its
 * money-free, edit-linked set. */
export const ListingRow = ({
  e,
  columnKeys,
  filters,
  columns = LISTING_TABLE_COLUMNS,
}: ListingColumnArgs & { e: ListingWithCount }): string => {
  const isInactive = !e.active;
  const cells = renderCells(
    e,
    columnKeys,
    columns,
    undefined,
    filters,
    escapeHtml,
  );
  return `<tr${isInactive ? ' class="inactive-row"' : ""}>${cells}</tr>`;
};

/** The subset of `columnKeys` that the given column set actually defines. */
export const validListingColumnKeys = (
  columnKeys: readonly string[],
  columns: ColumnGenerators<ListingWithCount>,
): string[] => columnKeys.filter((key) => columns[key]);

/** The listing collection + column layout every listings table renders from. */
type ListingTableArgs = ListingColumnArgs & {
  listings: ListingWithCount[];
};

/** Render the listing rows (or the single empty-state row) for a listings
 *  table body. Shared by the dashboard listings section and the group detail
 *  page; `emptyText` is the message shown when there are no listings. */
export const renderListingRows = ({
  listings,
  columnKeys,
  filters,
  emptyText,
  columns = LISTING_TABLE_COLUMNS,
}: ListingTableArgs & { emptyText: string }): string =>
  listings.length > 0
    ? pipe(
        map((e: ListingWithCount) =>
          ListingRow({ columnKeys, columns, e, filters }),
        ),
        joinStrings,
      )(listings)
    : `<tr><td colspan="${columnKeys.length}">${emptyText}</td></tr>`;

/** Render the listing table with dynamic column keys. `columns` defaults to the
 * staff column set; the editor variant passes its money-free set. */
export const renderListingTable = (
  columnKeys: readonly string[],
  rows: string,
  columns: ColumnGenerators<ListingWithCount> = LISTING_TABLE_COLUMNS,
): string => {
  const headers = pipe(
    map((key: string) => `<th>${getHeaderText(columns[key]!)}</th>`),
    joinStrings,
  )(validListingColumnKeys(columnKeys, columns));
  return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
};

export const renderListingsTableSection = (
  listings: ListingWithCount[],
  columnKeys: readonly string[],
  filters: ReadonlyMap<string, string>,
  columns: ColumnGenerators<ListingWithCount> = LISTING_TABLE_COLUMNS,
): string => {
  const listingRows = renderListingRows({
    columnKeys: validListingColumnKeys(columnKeys, columns),
    columns,
    emptyText: t("admin.dashboard.no_listings"),
    filters,
    listings,
  });

  return String(
    <TableScroll>
      <Raw html={renderListingTable(columnKeys, listingRows, columns)} />
    </TableScroll>,
  );
};

/** A listings table with an optional filter row above it. When `csvExport` is
 * set, a CSV-export footer is shown below in the same block. Shared by the
 * dashboard (active-only table, no export) and the
 * listings index (active + deactivated, exports all). */
export const ListingsTableBlock = ({
  listings,
  columnKeys,
  filters,
  csvExport = false,
  csvHref = "/admin/listings/csv",
  headerHtml = "",
  columns = LISTING_TABLE_COLUMNS,
}: ListingTableArgs & {
  csvExport?: boolean;
  csvHref?: string;
  headerHtml?: string;
}): JSX.Element => (
  <PageBlock>
    <Raw html={headerHtml} />
    <Raw
      html={renderListingsTableSection(listings, columnKeys, filters, columns)}
    />
    {csvExport && (
      <div class="table-actions">
        <a href={csvHref}>{t("listings_table.export_csv")}</a>
      </div>
    )}
  </PageBlock>
);
