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
 * The pure layout metadata (column keys, default order, layout parser) lives
 * in `#shared/tables/listing-layout.ts` so `settings.ts` can parse a saved
 * template without importing this UI module.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { defineTable, type TableColumn } from "#shared/tables/definition.ts";
import {
  LISTING_COLUMN_KEYS,
  LISTING_DEFAULT_COLUMN_KEYS,
} from "#shared/tables/listing-layout.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { renderListingImage } from "#templates/public/shared.tsx";

type ListingCol = TableColumn<ListingWithCount>;

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

const name: ListingCol = {
  cell: (e) => nameCell(e, `/admin/listing/${e.id}`),
  description: "Listing name with thumbnail image and link to listing detail",
  header: "Listing Name",
  key: "name",
  label: "Name",
  rawValue: (e) => e.name,
};

/** Editor variant: links to the edit form instead of the staff-only detail page. */
const editorName: ListingCol = {
  ...name,
  cell: (e) => nameCell(e, `/admin/listing/${e.id}/edit`),
};

const description: ListingCol = {
  cell: (e) => e.description,
  className: "cell-description",
  description: "Listing description text",
  header: "Description",
  key: "description",
  label: "Description",
};

const status: ListingCol = {
  cell: (e) => (e.active ? "Active" : "Inactive"),
  description: "Whether the listing is Active or Inactive",
  header: "Status",
  key: "status",
  label: "Status",
};

const attendees: ListingCol = {
  cell: (e) => `${e.attendee_count} / ${e.max_attendees}`,
  description: "Current attendee count vs maximum capacity",
  header: "Attendees",
  key: "attendees",
  label: "Attendees",
};

const tickets: ListingCol = {
  cell: (e) => String(e.tickets_count),
  description: "Number of bookings (ticket rows) sold for this listing",
  header: "Tickets",
  key: "tickets",
  label: "Tickets",
  rawValue: (e) => e.tickets_count,
};

const revenue: ListingCol = {
  cell: (e) => formatCurrency(e.income),
  description: "Total income taken for this listing (sum of payments)",
  header: "Revenue",
  key: "revenue",
  label: "Revenue",
  rawValue: (e) => e.income,
};

const cost: ListingCol = {
  cell: (e) => formatCurrency(e.cost),
  description: "Total servicing costs recorded for this listing",
  header: "Costs",
  key: "cost",
  label: "Costs",
  rawValue: (e) => e.cost,
};

const profit: ListingCol = {
  cell: (e) => formatCurrency(e.profit),
  description: "Revenue less servicing costs for this listing",
  header: "Profit",
  key: "profit",
  label: "Profit",
  rawValue: (e) => e.profit,
};

const created: ListingCol = {
  cell: (e) => new Date(e.created).toLocaleDateString(),
  description: "Date the listing was created",
  header: "Created",
  key: "created",
  label: "Created",
  rawValue: (e) => e.created,
};

const date: ListingCol = {
  cell: (e) => (e.date ? new Date(e.date).toLocaleDateString() : ""),
  description: "Scheduled listing date",
  header: "Date",
  key: "date",
  label: "Date",
  rawValue: (e) => e.date || "",
};

const location: ListingCol = {
  cell: (e) => e.location,
  description: "Listing location",
  header: "Location",
  key: "location",
  label: "Location",
};

const price: ListingCol = {
  cell: (e) => (e.unit_price > 0 ? String(e.unit_price) : "Free"),
  description: "Ticket unit price (in minor currency units)",
  header: "Price",
  key: "price",
  label: "Price",
  rawValue: (e) => e.unit_price,
};

const renewal: ListingCol = {
  cell: (e) =>
    e.months_per_unit > 0 ? `Renewal (${e.months_per_unit}mo)` : "",
  description:
    "Whether this listing is a renewal tier and its duration in months",
  header: "Renewal",
  key: "renewal",
  label: "Renewal",
  rawValue: (e) => e.months_per_unit,
};

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

/** The staff listing table — 9 default columns plus 4 extras the operator
 *  may add via a saved column template. */
export const listingTable = defineTable(
  [
    name,
    description,
    status,
    attendees,
    tickets,
    revenue,
    cost,
    profit,
    created,
    date,
    location,
    price,
    renewal,
  ],
  {
    configKeys: LISTING_COLUMN_KEYS,
    defaultColumnKeys: LISTING_DEFAULT_COLUMN_KEYS,
  },
);

/** The editor listing table: a money-free subset at a fixed order. */
export const editorListingTable = defineTable<ListingWithCount>([
  editorName,
  description,
  status,
  attendees,
  tickets,
  created,
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
    columnKeys: args.columnKeys ?? table.defaultColumnKeys,
    empty: args.emptyText,
    filters: args.filters,
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
