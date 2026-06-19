/**
 * Listings CSV export — the first consumer of the generic {@link toCsv}
 * utility. Each listing becomes a typed row keyed by localised column headers;
 * the headers double as the ordered column list passed to `toCsv`, which keeps
 * the two in lock-step and validates them against each other.
 */

import { t } from "#i18n";
import { toCsv } from "#shared/csv/generate.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { listingCategory, listingFilterLabel } from "#shared/listing-filter.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** A listing CSV column: its header and how to render a listing's cell. */
type ListingCsvColumn = {
  header: string;
  value: (listing: ListingWithCount) => string;
};

/** Ordered listing CSV columns. Headers are resolved at call time so the
 * active locale applies. */
const listingCsvColumns = (): ListingCsvColumn[] => [
  { header: t("common.name"), value: (l) => l.name },
  {
    header: t("common.status"),
    value: (l) => (l.active ? t("common.active") : t("common.inactive")),
  },
  {
    header: t("csv.col.type"),
    value: (l) => listingFilterLabel(listingCategory(l)),
  },
  { header: t("csv.col.attendees"), value: (l) => String(l.attendee_count) },
  { header: t("csv.col.capacity"), value: (l) => String(l.max_attendees) },
  { header: t("csv.col.tickets"), value: (l) => String(l.tickets_count) },
  { header: t("csv.col.revenue"), value: (l) => toMajorUnits(l.income) },
  {
    header: t("csv.col.price"),
    value: (l) =>
      l.unit_price > 0 ? toMajorUnits(l.unit_price) : t("listings_table.free"),
  },
  {
    header: t("common.date"),
    value: (l) => (l.date ? l.date.slice(0, 10) : ""),
  },
  { header: t("listings_table.location"), value: (l) => l.location },
  {
    header: t("common.created"),
    value: (l) => new Date(l.created).toISOString(),
  },
  { header: t("common.description"), value: (l) => l.description },
];

/** Generate CSV content for a set of listings (one row per listing). */
export const generateListingsCsv = (listings: ListingWithCount[]): string => {
  const columns = listingCsvColumns();
  const keys = columns.map((c) => c.header);
  const rows = listings.map((listing) =>
    Object.fromEntries(columns.map((c) => [c.header, c.value(listing)])),
  );
  return toCsv(rows, keys);
};
