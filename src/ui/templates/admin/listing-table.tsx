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
import { formatDateLabel } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { TableColumn } from "#shared/tables/column.ts";
import {
  configurableTableLayouts,
  type ListingColumnKey,
} from "#shared/tables/configurable.ts";
import {
  attachTableRenderers,
  columnOrThrow,
  defineTable,
} from "#shared/tables/definition.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { renderTable, tableColumnText } from "#templates/components/table.tsx";
import { renderListingImage } from "#templates/public/shared.tsx";

type ListingRenderer = Omit<
  TableColumn<ListingWithCount, undefined, ListingColumnKey>,
  "key"
>;

const listingColumnText = tableColumnText("listings_table.column");

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
  ...listingColumnText("name", "header"),
  cell: (e) => nameCell(e, `/admin/listing/${e.id}`),
};

/** Editor variant: links to the edit form instead of the staff-only detail page. */
const editorName: ListingRenderer = {
  ...name,
  cell: (e) => nameCell(e, `/admin/listing/${e.id}/edit`),
};

const description: ListingRenderer = {
  ...listingColumnText("description"),
  cell: (e) => e.description,
  className: "cell-description",
};

const status: ListingRenderer = {
  ...listingColumnText("status"),
  cell: (e) => (e.active ? t("common.active") : t("common.inactive")),
};

const attendees: ListingRenderer = {
  ...listingColumnText("attendees"),
  cell: (e) => `${e.attendee_count} / ${e.max_attendees}`,
};

const tickets: ListingRenderer = {
  ...listingColumnText("tickets"),
  cell: (e) => String(e.tickets_count),
  rawValue: (e) => e.tickets_count,
};

const revenue: ListingRenderer = {
  ...listingColumnText("revenue"),
  cell: (e) => formatCurrency(e.income),
  rawValue: (e) => e.income,
};

const cost: ListingRenderer = {
  ...listingColumnText("cost"),
  cell: (e) => formatCurrency(e.cost),
  rawValue: (e) => e.cost,
};

const profit: ListingRenderer = {
  ...listingColumnText("profit"),
  cell: (e) => formatCurrency(e.profit),
  rawValue: (e) => e.profit,
};

const created: ListingRenderer = {
  ...listingColumnText("created"),
  cell: (e) => formatDateLabel(e.created.slice(0, 10)),
  rawValue: (e) => e.created,
};

const date: ListingRenderer = {
  ...listingColumnText("date"),
  cell: (e) => (e.date ? formatDateLabel(e.date.slice(0, 10)) : ""),
  rawValue: (e) => e.date || "",
};

const location: ListingRenderer = {
  ...listingColumnText("location"),
  cell: (e) => e.location,
};

const price: ListingRenderer = {
  ...listingColumnText("price"),
  cell: (e) =>
    e.unit_price > 0 ? formatCurrency(e.unit_price) : t("listings_table.free"),
  rawValue: (e) => e.unit_price,
};

const renewal: ListingRenderer = {
  ...listingColumnText("renewal"),
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
export const editorListingTable = defineTable<
  ListingWithCount,
  undefined,
  ListingColumnKey
>([
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
type ListingTableVariant = typeof listingTable | typeof editorListingTable;

/** Shared input: the rows, the parsed column layout, and an optional variant. */
type ListingTableArgs = {
  listings: ListingWithCount[];
  readonly columnKeys?: readonly ListingColumnKey[] | undefined;
  readonly filters?: ReadonlyMap<ListingColumnKey, string> | undefined;
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
    columnKeys:
      args.columnKeys ??
      (table === listingTable
        ? listingTable.layout.defaultColumnKeys
        : undefined),
    empty: args.emptyText,
    filters: args.filters,
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
