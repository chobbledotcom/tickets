/**
 * Listings CSV export. Describes each listing column once (header + how to read
 * the cell) and hands the listings and columns to the pure {@link CSV.generate}.
 */

import { t } from "#i18n";
import { type Column, CSV } from "#shared/csv/index.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { listingCategory, listingFilterLabel } from "#shared/listing-filter.ts";
import type { ListingWithCount } from "#shared/types.ts";

/** Ordered listing CSV columns. Built per call so the active locale applies. */
const listingColumns = (): Column<ListingWithCount>[] => [
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
export const generateListingsCsv = (listings: ListingWithCount[]): string =>
  CSV.generate(listings, listingColumns());
