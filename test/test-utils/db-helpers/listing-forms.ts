import { toMajorUnits } from "#shared/currency.ts";
import type { ListingInput } from "#shared/db/listings.ts";
import type { DayPrices, ListingWithCount } from "#shared/types.ts";

const bool = (v: unknown): string => (v ? "1" : "");
const optionalNumber = (v: number | null | undefined): string =>
  v != null ? String(v) : "";
const optionalPrice = (v: number | null | undefined): string =>
  v != null ? toMajorUnits(v) : "";
const formatBookableDaysForForm = (days: string[]): string => days.join(",");

/** Serialize a DayPrices map into the form's `day_price_<n>` fields. */
const dayPriceFormFields = (
  dayPrices: DayPrices | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [days, price] of Object.entries(dayPrices ?? {})) {
    result[`day_price_${days}`] = toMajorUnits(price);
  }
  return result;
};

const splitClosesAt = (
  update: string | undefined,
  existing: string | null,
): { date: string; time: string } => {
  const value = update !== undefined ? update : (existing?.slice(0, 16) ?? "");
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

const pickField = <T>(update: T | undefined, existing: T): T =>
  update !== undefined ? update : existing;

const formatOptional = (update: string | undefined, existing: string): string =>
  update ?? existing;

const formatPrice = (update: number | undefined, existing: number): string =>
  update !== undefined ? toMajorUnits(update) : toMajorUnits(existing);

export const priceFormValue = (minorUnits: number): string =>
  toMajorUnits(minorUnits);

export const buildCreateListingForm = (
  input: Omit<ListingInput, "slug" | "slugIndex">,
): Record<string, string> => {
  const closesAtParts = splitClosesAt(input.closesAt, null);
  const dateParts = splitClosesAt(input.date, null);
  const initialSiteMonths = input.assignBuiltSite
    ? (input.initialSiteMonths ?? 1)
    : (input.initialSiteMonths ?? 0);
  return {
    assign_built_site: bool(input.assignBuiltSite),
    bookable_alone: bool(input.bookableAlone),
    bookable_days: input.bookableDays
      ? formatBookableDaysForForm(input.bookableDays)
      : "",
    can_pay_more: bool(input.canPayMore),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    customisable_days: bool(input.customisableDays),
    date_date: dateParts.date,
    date_time: dateParts.time,
    description: input.description ?? "",
    duration_days: optionalNumber(input.durationDays),
    uses_logistics: bool(input.usesLogistics),
    ...dayPriceFormFields(input.dayPrices),
    fields: input.fields ?? "email",
    hidden: bool(input.hidden),
    initial_site_months: String(initialSiteMonths),
    listing_type: input.listingType ?? "",
    location: input.location ?? "",
    max_attendees: String(input.maxAttendees),
    max_price: toMajorUnits(input.maxPrice),
    max_quantity: String(input.maxQuantity ?? 1),
    maximum_days_after: optionalNumber(input.maximumDaysAfter),
    minimum_days_before: optionalNumber(input.minimumDaysBefore),
    months_per_unit: String(input.monthsPerUnit ?? 0),
    name: input.name,
    non_transferable: bool(input.nonTransferable),
    purchase_only: bool(input.purchaseOnly),
    thank_you_url: input.thankYouUrl ?? "",
    unit_price: optionalPrice(input.unitPrice),
    use_defaults: bool(input.useDefaults),
    webhook_url: input.webhookUrl ?? "",
  };
};

const buildUpdateBoolFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => ({
  assign_built_site: bool(
    pickField(updates.assignBuiltSite, existing.assign_built_site),
  ),
  bookable_alone: bool(
    pickField(updates.bookableAlone, existing.bookable_alone),
  ),
  can_pay_more: bool(pickField(updates.canPayMore, existing.can_pay_more)),
  hidden: bool(pickField(updates.hidden, existing.hidden)),
  non_transferable: bool(
    pickField(updates.nonTransferable, existing.non_transferable),
  ),
  purchase_only: bool(pickField(updates.purchaseOnly, existing.purchase_only)),
  use_defaults: bool(pickField(updates.useDefaults, existing.use_defaults)),
  uses_logistics: bool(
    pickField(updates.usesLogistics, existing.uses_logistics),
  ),
});

const buildUpdateNumericFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => {
  const assignsBuiltSite = pickField(
    updates.assignBuiltSite,
    existing.assign_built_site,
  );
  const initialSiteMonths = assignsBuiltSite
    ? pickField(updates.initialSiteMonths, existing.initial_site_months || 1)
    : pickField(updates.initialSiteMonths, existing.initial_site_months);
  return {
    duration_days: String(
      pickField(updates.durationDays, existing.duration_days),
    ),
    initial_site_months: String(initialSiteMonths),
    max_attendees: String(
      pickField(updates.maxAttendees, existing.max_attendees),
    ),
    max_price: toMajorUnits(pickField(updates.maxPrice, existing.max_price)),
    max_quantity: String(pickField(updates.maxQuantity, existing.max_quantity)),
    maximum_days_after: String(
      pickField(updates.maximumDaysAfter, existing.maximum_days_after),
    ),
    minimum_days_before: String(
      pickField(updates.minimumDaysBefore, existing.minimum_days_before),
    ),
    months_per_unit: String(
      pickField(updates.monthsPerUnit, existing.months_per_unit),
    ),
    unit_price: formatPrice(updates.unitPrice, existing.unit_price),
  };
};

const buildUpdateStringFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => ({
  bookable_days: formatBookableDaysForForm(
    pickField(updates.bookableDays, existing.bookable_days),
  ),
  description: pickField(updates.description, existing.description),
  fields: pickField(updates.fields, existing.fields),
  listing_type: pickField(updates.listingType, existing.listing_type),
  location: pickField(updates.location, existing.location),
  name: pickField(updates.name, existing.name),
  slug: pickField(updates.slug, existing.slug),
  thank_you_url: formatOptional(updates.thankYouUrl, existing.thank_you_url),
  webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
});

export const buildUpdateListingForm = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => {
  const closesAtParts = splitClosesAt(updates.closesAt, existing.closes_at);
  const dateParts = splitClosesAt(updates.date, existing.date);
  return {
    ...buildUpdateBoolFields(updates, existing),
    ...buildUpdateNumericFields(updates, existing),
    ...buildUpdateStringFields(updates, existing),
    ...dayPriceFormFields(updates.dayPrices ?? existing.day_prices),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    customisable_days: bool(
      updates.customisableDays ?? existing.customisable_days,
    ),
    date_date: dateParts.date,
    date_time: dateParts.time,
  };
};
