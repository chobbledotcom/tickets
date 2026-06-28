/**
 * Listing table column definitions.
 *
 * Maps column keys to their rendering logic for the admin dashboard listing table.
 * This is the single source of truth for available listing columns, their headers,
 * cell rendering, and guide documentation.
 */

import type { ColumnDef, ColumnGenerators } from "#shared/column-order.ts";
import { formatCurrency } from "#shared/currency.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { renderListingImage } from "#templates/public.tsx";

type ListingCol = ColumnDef<ListingWithCount>;

/** Name cell: thumbnail + a link to the given listing page. The link target
 * varies by role — staff get the attendee detail page, editors (who can't open
 * it) get the edit form — so the path is a parameter. */
const nameCell = (e: ListingWithCount, href: string): string =>
  `${renderListingImage(e, "listing-thumbnail")}<a href="${href}">${escapeHtml(
    e.name,
  )}</a>`;

const name: ListingCol = {
  cell: (e) => nameCell(e, `/admin/listing/${e.id}`),
  description: "Listing name with thumbnail image and link to listing detail",
  headerText: "Listing Name",
  isHtml: true,
  label: "Name",
};

/** Editor variant of the name column: links to the edit form instead of the
 * attendee-centric detail page, which editors may not open. */
const editorName: ListingCol = {
  ...name,
  cell: (e) => nameCell(e, `/admin/listing/${e.id}/edit`),
};

const description: ListingCol = {
  cell: (e) => e.description,
  className: "cell-description",
  description: "Listing description text",
  label: "Description",
};

const status: ListingCol = {
  cell: (e) => (e.active ? "Active" : "Inactive"),
  description: "Whether the listing is Active or Inactive",
  label: "Status",
};

const attendees: ListingCol = {
  cell: (e) => `${e.attendee_count} / ${e.max_attendees}`,
  description: "Current attendee count vs maximum capacity",
  label: "Attendees",
};

const tickets: ListingCol = {
  cell: (e) => String(e.tickets_count),
  description: "Number of bookings (ticket rows) sold for this listing",
  label: "Tickets",
  rawValue: (e) => e.tickets_count,
};

const revenue: ListingCol = {
  cell: (e) => formatCurrency(e.income),
  description: "Total income taken for this listing (sum of payments)",
  label: "Revenue",
  rawValue: (e) => e.income,
};

const cost: ListingCol = {
  cell: (e) => formatCurrency(e.cost),
  description: "Total servicing costs recorded for this listing",
  label: "Costs",
  rawValue: (e) => e.cost,
};

const profit: ListingCol = {
  cell: (e) => formatCurrency(e.profit),
  description: "Revenue less servicing costs for this listing",
  label: "Profit",
  rawValue: (e) => e.profit,
};

const created: ListingCol = {
  cell: (e) => new Date(e.created).toLocaleDateString(),
  description: "Date the listing was created",
  label: "Created",
  rawValue: (e) => e.created,
};

const date: ListingCol = {
  cell: (e) => (e.date ? new Date(e.date).toLocaleDateString() : ""),
  description: "Scheduled listing date",
  label: "Date",
  rawValue: (e) => e.date || "",
};

const location: ListingCol = {
  cell: (e) => e.location,
  description: "Listing location",
  label: "Location",
};

const price: ListingCol = {
  cell: (e) => (e.unit_price > 0 ? String(e.unit_price) : "Free"),
  description: "Ticket unit price (in minor currency units)",
  label: "Price",
  rawValue: (e) => e.unit_price,
};

const renewal: ListingCol = {
  cell: (e) =>
    e.months_per_unit > 0 ? `Renewal (${e.months_per_unit}mo)` : "",
  description:
    "Whether this listing is a renewal tier and its duration in months",
  label: "Renewal",
  rawValue: (e) => e.months_per_unit,
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** All available listing table columns */
export const LISTING_TABLE_COLUMNS: ColumnGenerators<ListingWithCount> = {
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
};

/** Default column order for the listing table */
export const LISTING_DEFAULT_ORDER = [
  "name",
  "description",
  "status",
  "attendees",
  "tickets",
  "revenue",
  "cost",
  "profit",
  "created",
] as const;

/** Listing columns shown to editors: the ledger-derived money columns
 * (revenue/cost/profit) are omitted entirely — not just unordered — so a saved
 * column template can never surface them, and the name links to the edit form
 * rather than the forbidden detail page. */
export const EDITOR_LISTING_TABLE_COLUMNS: ColumnGenerators<ListingWithCount> = {
  attendees,
  created,
  date,
  description,
  location,
  name: editorName,
  price,
  renewal,
  status,
  tickets,
};

/** Default column order for the editor listing table (no money columns). */
export const EDITOR_LISTING_DEFAULT_ORDER = [
  "name",
  "description",
  "status",
  "attendees",
  "tickets",
  "created",
] as const;
