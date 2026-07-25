/**
 * The admin listings tables: column definitions, cell renderers, and the
 * composition helpers (`ListingsTableBlock`, `renderListingsTableSection`)
 * used by the dashboard, listings index, and group detail page.
 *
 * Listings are the only admin table whose column order is user-configurable:
 * the operator picks which columns appear (and in what order) via a
 * Liquid-style template saved in `listing_column_order`.
 *
 * Editors see a fixed, money-free variant (`editorListingTable`) whose name
 * column links to the edit form rather than the staff-only detail page.
 *
 * The pure layout schema lives in `#shared/tables/configurable.ts`, so settings
 * code can parse saved templates without importing this UI module.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  configurableTableLayouts,
  type ListingColumnKey,
} from "#shared/tables/configurable.ts";
import {
  attachTableRenderers,
  columnOrThrow,
  defineTable,
  type TableColumn,
} from "#shared/tables/definition.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { renderTable, tableColumnText } from "#templates/components/table.tsx";
import { filteredTableCells } from "#templates/components/table-filters.ts";
import { renderListingImage } from "#templates/public/shared.tsx";

type ListingRenderer = Omit<
  TableColumn<ListingWithCount, undefined, ListingColumnKey>,
  "key"
>;

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/** Name cell: thumbnail + a link to the given listing page. The link target
 * varies by role — staff get the attendee detail page, editors (who can't
 * open it) get the edit form — so the path is a parameter. */
const nameCell = (e: ListingWithCount, href: string): JSX.Element => (
  <>
    <Raw html={renderListingImage(e, "listing-thumbnail", { thumb: true })} />
    <a href={href}>{e.name}</a>
  </>
);

const name: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.name.label"),
    () => t("listings_table.column.name.description"),
    () => t("listings_table.column.name.header"),
  ),
  cell: (e) => nameCell(e, `/admin/listing/${e.id}`),
};

/** Editor variant: links to the edit form instead of the staff-only detail page. */
const editorName: ListingRenderer = {
  ...name,
  cell: (e) => nameCell(e, `/admin/listing/${e.id}/edit`),
};

const description: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.description.label"),
    () => t("listings_table.column.description.description"),
  ),
  cell: (e) => e.description,
  className: "cell-description",
};

const status: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.status.label"),
    () => t("listings_table.column.status.description"),
  ),
  cell: (e) => (e.active ? t("common.active") : t("common.inactive")),
};

const attendees: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.attendees.label"),
    () => t("listings_table.column.attendees.description"),
  ),
  cell: (e) => `${e.attendee_count} / ${e.max_attendees}`,
};

const tickets: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.tickets.label"),
    () => t("listings_table.column.tickets.description"),
  ),
  cell: (e) => String(e.tickets_count),
  rawValue: (e) => e.tickets_count,
};

const revenue: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.revenue.label"),
    () => t("listings_table.column.revenue.description"),
  ),
  cell: (e) => formatCurrency(e.income),
  rawValue: (e) => e.income,
};

const cost: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.cost.label"),
    () => t("listings_table.column.cost.description"),
  ),
  cell: (e) => formatCurrency(e.cost),
  rawValue: (e) => e.cost,
};

const profit: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.profit.label"),
    () => t("listings_table.column.profit.description"),
  ),
  cell: (e) => formatCurrency(e.profit),
  rawValue: (e) => e.profit,
};

const created: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.created.label"),
    () => t("listings_table.column.created.description"),
  ),
  cell: (e) => new Date(e.created).toLocaleDateString(),
  rawValue: (e) => e.created,
};

const date: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.date.label"),
    () => t("listings_table.column.date.description"),
  ),
  cell: (e) => (e.date ? new Date(e.date).toLocaleDateString() : ""),
  rawValue: (e) => e.date || "",
};

const location: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.location.label"),
    () => t("listings_table.column.location.description"),
  ),
  cell: (e) => e.location,
};

const price: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.price.label"),
    () => t("listings_table.column.price.description"),
  ),
  cell: (e) =>
    e.unit_price > 0 ? String(e.unit_price) : t("listings_table.free"),
  rawValue: (e) => e.unit_price,
};

const renewal: ListingRenderer = {
  ...tableColumnText(
    () => t("listings_table.column.renewal.label"),
    () => t("listings_table.column.renewal.description"),
  ),
  cell: (e) =>
    e.months_per_unit > 0
      ? t("listings_table.column.renewal.value", {
          months: e.months_per_unit,
        })
      : "",
  rawValue: (e) => e.months_per_unit,
};

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/** The staff listing table — 9 default columns plus 4 extras the operator
 *  may add via a saved column template. */
export const listingTable = attachTableRenderers(
  configurableTableLayouts.listing,
  {
    attendees,
    cost,
    created,
    date,
    description,
    location,
    name,
    price,
    profit,
    renewal,
    revenue,
    status,
    tickets,
  },
);

/** The editor listing table: a money-free subset at a fixed order. */
export const editorListingTable = defineTable<ListingWithCount>([
  { ...editorName, key: "name" },
  columnOrThrow(listingTable, "description"),
  columnOrThrow(listingTable, "status"),
  columnOrThrow(listingTable, "attendees"),
  columnOrThrow(listingTable, "tickets"),
  columnOrThrow(listingTable, "created"),
]);

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

/** The staff listing table by default; editors see `editorListingTable`
 *  (a money-free, edit-linked subset). */
export type ListingTableVariant =
  | typeof listingTable
  | typeof editorListingTable;

/** Shared input: the rows, the parsed column layout, and an optional variant. */
export type ListingTableArgs = {
  listings: ListingWithCount[];
  readonly columnKeys?: readonly string[] | undefined;
  readonly filters?: ReadonlyMap<string, string> | undefined;
  readonly table?: ListingTableVariant | undefined;
};

const resolveTable = (table: ListingTableVariant | undefined) =>
  table ?? listingTable;

/** Render the listings table (rows + header + scroll wrapper). */
export const renderListingsTableSection = (
  args: ListingTableArgs & { emptyText: string },
): JSX.Element => {
  const table = resolveTable(args.table);
  return renderTable(table, args.listings, {
    columnKeys: args.columnKeys ?? table.layout.defaultColumnKeys,
    empty: args.emptyText,
    renderCell: filteredTableCells(args.filters ?? new Map()),
    rowAttrs: (listing) => (listing.active ? {} : { class: "inactive-row" }),
  });
};

/** A listings table with an optional filter row above it and CSV-export
 *  footer below. Shared by the dashboard and the listings index. */
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
