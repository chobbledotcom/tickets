/**
 * The admin listings tables: column definitions, cell renderers, and the
 * composition helpers the dashboard, listings index, and group detail page use.
 *
 * The operator picks which columns appear, and in what order, with a
 * Liquid-style template saved in `listing_column_order`. The pure layout schema
 * lives in `#shared/tables/configurable.ts`, so settings code can parse a saved
 * template without an import of this UI module.
 *
 * Editors get a money-free variant whose name column links to the edit form,
 * because the detail page is staff-only.
 */

import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { markdownToPlainText } from "#shared/markdown-plain-text.ts";
import type {
  ReorderColumnOptions,
  TableColumn,
} from "#shared/tables/column.ts";
import {
  configurableTableLayouts,
  type ListingColumnKey,
} from "#shared/tables/configurable.ts";
import {
  attachTableRenderers,
  defineTable,
  type TableDefinition,
} from "#shared/tables/definition.ts";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { renderTable, tableColumnText } from "#templates/components/table.tsx";
import { translatedTableHeader } from "#templates/components/translated-table-column.ts";
import { renderListingImage } from "#templates/public/shared.tsx";
import type { ListingWithCount } from "#types";

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
  cell: (e) => markdownToPlainText(e.description),
  className: "cell-description",
};

const status: ListingRenderer = {
  ...listingColumnText("status"),
  cell: (e) => (e.active ? t("common.active") : t("common.inactive")),
};

const attendees: ListingRenderer = {
  ...listingColumnText("attendees"),
  cell: (e) => `${e.attendeeCount} / ${e.maxAttendees}`,
};

const tickets: ListingRenderer = {
  ...listingColumnText("tickets"),
  cell: (e) => String(e.ticketsCount),
  rawValue: (e) => e.ticketsCount,
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
    e.unitPrice > 0 ? formatCurrency(e.unitPrice) : t("listings_table.free"),
  rawValue: (e) => e.unitPrice,
};

const renewal: ListingRenderer = {
  ...listingColumnText("renewal"),
  cell: (e) =>
    e.monthsPerUnit > 0
      ? t("listings_table.column.renewal.value", {
          months: e.monthsPerUnit,
        })
      : "",
  rawValue: (e) => e.monthsPerUnit,
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

const editorListingColumns = [
  { ...editorName, key: "name" },
  { ...description, key: "description" },
  { ...status, key: "status" },
  { ...attendees, key: "attendees" },
  { ...tickets, key: "tickets" },
  { ...created, key: "created" },
] as const satisfies readonly TableColumn<
  ListingWithCount,
  undefined,
  ListingColumnKey
>[];

type EditorListingColumnKey = (typeof editorListingColumns)[number]["key"];

/** The editor listing table: a money-free subset at a fixed order. */
const editorListingTable = defineTable<
  ListingWithCount,
  undefined,
  EditorListingColumnKey
>(editorListingColumns);

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

type ListingRows<TKey extends ListingColumnKey> = {
  listings: ListingWithCount[];
  /** The drag handle and arrows, on the listings page only. */
  readonly reorder?: ReorderColumnOptions<ListingWithCount> | undefined;
  readonly columnKeys?: readonly TKey[] | undefined;
  readonly filters?: ReadonlyMap<TKey, string> | undefined;
};

/** The table variant and its supported columns stay one typed choice. */
type ListingTableArgs =
  | (ListingRows<ListingColumnKey> & { readonly table?: "staff" | undefined })
  | (ListingRows<EditorListingColumnKey> & { readonly table: "editor" });

const renderListingTable = <TKey extends ListingColumnKey>(
  table: TableDefinition<ListingWithCount, undefined, TKey>,
  args: ListingRows<TKey>,
  emptyText: string,
  defaultColumnKeys?: readonly TKey[],
): JSX.Element =>
  renderTable(table, args.listings, {
    columnKeys: args.columnKeys ?? defaultColumnKeys,
    empty: emptyText,
    filters: args.filters,
    reorder: args.reorder,
    rowAttrs: (listing) => (listing.active ? {} : { class: "inactive-row" }),
  });

/** The reorder column of the listings page: each listing moves through its
 *  own move routes, named by its id. */
export const LISTING_REORDER: ReorderColumnOptions<ListingWithCount> = {
  anchor: (listing) => String(listing.id),
  header: translatedTableHeader("listings_table.order_column"),
  path: (listing) => `/admin/listing/${listing.id}`,
};

/** Render the listings table (rows + header + scroll wrapper). */
export const renderListingsTableSection = (
  args: ListingTableArgs & { emptyText: string },
): JSX.Element =>
  args.table === "editor"
    ? renderListingTable(editorListingTable, args, args.emptyText)
    : renderListingTable(
        listingTable,
        args,
        args.emptyText,
        listingTable.layout.defaultColumnKeys,
      );

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
      ...args,
      emptyText: t("admin.dashboard.no_listings"),
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
