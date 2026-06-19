/**
 * Listings CSV export. Describes each listing column once (header + how to read
 * the cell) and hands the listings and columns to the pure {@link CSV.generate}.
 */

import { t } from "#i18n";
import { type Column, CSV } from "#shared/csv/index.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { listingCategory, listingFilterLabel } from "#shared/listing-filter.ts";
import { DEFAULT_TIMEZONE, utcToLocalInput } from "#shared/timezone.ts";
import {
  availableDayCounts,
  dayPriceFor,
  type ListingWithCount,
} from "#shared/types.ts";

/** The export's Price cell: the unit price, or — for a customisable-days
 * listing whose base price is 0 — the range of its day prices, or "Free" when
 * genuinely free. Avoids labelling paid day-priced listings as Free. */
const listingPriceLabel = (l: ListingWithCount): string => {
  if (l.unit_price > 0) return toMajorUnits(l.unit_price);
  const dayPrices = availableDayCounts(l).map((n) => dayPriceFor(l, n)!);
  if (dayPrices.length === 0) return t("listings_table.free");
  const min = Math.min(...dayPrices);
  const max = Math.max(...dayPrices);
  return min === max
    ? toMajorUnits(min)
    : `${toMajorUnits(min)}–${toMajorUnits(max)}`;
};

/** Ordered listing CSV columns. Built per call so the active locale applies. */
const listingColumns = (tz: string): Column<ListingWithCount>[] => [
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
  { header: t("csv.col.price"), value: listingPriceLabel },
  {
    header: t("common.date"),
    // listing.date is a UTC ISO timestamp; convert through the configured
    // timezone so the calendar day matches what admins see elsewhere.
    value: (l) => (l.date ? utcToLocalInput(l.date, tz).slice(0, 10) : ""),
  },
  { header: t("listings_table.location"), value: (l) => l.location },
  {
    header: t("common.created"),
    value: (l) => new Date(l.created).toISOString(),
  },
  { header: t("common.description"), value: (l) => l.description },
];

/** Generate CSV content for a set of listings (one row per listing). The Date
 * column is rendered in `tz` (the site's configured timezone). */
export const generateListingsCsv = (
  listings: ListingWithCount[],
  tz: string = DEFAULT_TIMEZONE,
): string => CSV.generate(listings, listingColumns(tz));
