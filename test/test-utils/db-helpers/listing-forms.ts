import { settings } from "#db/settings.ts";
import { isNotNullish } from "#fp";
import { toMajorUnits } from "#shared/currency.ts";
import { showUseDefaultsToggle } from "#shared/listing-defaults.ts";
import {
  LISTING_FIELDS,
  type ListingInput,
} from "#shared/records/listing-fields.ts";
import { closedFieldsFor } from "#shared/records/write-access.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import type { AdminLevel, DayPrices, ListingWithCount } from "#types";

const checked = (name: string, value: unknown): TestFormValues =>
  value ? { [name]: "1" } : {};
const flagChoice = (value: unknown): string => (value ? "1" : "");
const optionalNumber = (v: number | null | undefined): string =>
  isNotNullish(v) ? String(v) : "";
const repeated = (value: string): string[] =>
  value ? value.split(",").map((part) => part.trim()) : [];

/** Serialize a DayPrices map into the form's `day_price_<n>` fields. */
const dayPriceFormFields = (
  dayPrices: DayPrices | undefined,
): TestFormValues => {
  const result: Record<string, string> = {};
  for (const [days, price] of Object.entries(dayPrices ?? {})) {
    result[`day_price_${days}`] = toMajorUnits(price);
  }
  return result;
};

const splitClosesAt = (
  update: string | null | undefined,
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

/** True when the writer's listing page shows the "use defaults" switch. */
export const defaultsSwitchShown = (adminLevel: AdminLevel): boolean =>
  showUseDefaultsToggle(
    closedFieldsFor(LISTING_FIELDS, adminLevel),
    settings.listingDefaults,
  );

/** Keep only the boxes the writer's listing page shows: the page hides the
 *  box of each field the writer cannot set, and refuses a form that sends one. */
const pageBoxes = (
  values: TestFormValues,
  adminLevel: AdminLevel,
): TestFormValues => {
  const closed = closedFieldsFor(LISTING_FIELDS, adminLevel);
  const shownDefaults = defaultsSwitchShown(adminLevel);
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !closed.has(key) && (shownDefaults || key !== "use_defaults"),
    ),
  );
};

/** True when a box holds what an untouched page sends. */
const isUntouched = (value: TestFormValues[string]): boolean =>
  value === "" || value === "0";

/** The create form a writer's page sends. A fixture that asks for a value
 *  in a box the page hides throws, so it must turn the feature on first. */
export const buildCreateListingForm = (
  input: Omit<ListingInput, "slug" | "slugIndex">,
  adminLevel: AdminLevel = "owner",
): TestFormValues => {
  const boxes = createListingBoxes(input);
  const shown = pageBoxes(boxes, adminLevel);
  const hidden = Object.keys(boxes).filter(
    (key) => !(key in shown) && !isUntouched(boxes[key]!),
  );
  if (hidden.length > 0) {
    throw new Error(
      `The listing page hides ${hidden.join(", ")}. Turn its feature on first.`,
    );
  }
  return shown;
};

const createListingBoxes = (
  input: Omit<ListingInput, "slug" | "slugIndex">,
): TestFormValues => {
  const closesAtParts = splitClosesAt(input.closesAt, null);
  const dateParts = splitClosesAt(input.date, null);
  const initialSiteMonths =
    input.initialSiteMonths ?? (input.assignBuiltSite ? 1 : 0);
  return {
    ...checked("assign_built_site", input.assignBuiltSite),
    ...checked("bookable_alone", input.bookableAlone),
    bookable_days: input.bookableDays ?? [],
    ...checked("can_pay_more", input.canPayMore),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    ...checked("customisable_days", input.customisableDays),
    date_date: dateParts.date,
    date_time: dateParts.time,
    description: input.description ?? "",
    duration_days: optionalNumber(input.durationDays),
    ...checked("uses_logistics", input.usesLogistics),
    ...dayPriceFormFields(input.dayPrices),
    fields: repeated(input.fields ?? "email"),
    ...checked("hidden", input.hidden),
    initial_site_months: String(initialSiteMonths),
    listing_type: input.listingType ?? "",
    location: input.location ?? "",
    max_attendees: String(input.maxAttendees),
    max_price: toMajorUnits(input.maxPrice),
    max_quantity: String(input.maxQuantity ?? 1),
    maximum_days_after: optionalNumber(input.maximumDaysAfter),
    min_quantity: String(input.minQuantity ?? 1),
    minimum_days_before: optionalNumber(input.minimumDaysBefore),
    months_per_unit: String(input.monthsPerUnit ?? 0),
    name: input.name,
    non_transferable: flagChoice(input.nonTransferable),
    ...checked("purchase_only", input.purchaseOnly),
    thank_you_url: input.thankYouUrl ?? "",
    unit_price: toMajorUnits(input.unitPrice ?? 0),
    ...checked("use_defaults", input.useDefaults),
    webhook_url: input.webhookUrl ?? "",
  };
};

const buildUpdateBoolFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): TestFormValues => ({
  ...checked(
    "assign_built_site",
    pickField(updates.assignBuiltSite, existing.assign_built_site),
  ),
  ...checked(
    "bookable_alone",
    pickField(updates.bookableAlone, existing.bookable_alone),
  ),
  ...checked(
    "can_pay_more",
    pickField(updates.canPayMore, existing.can_pay_more),
  ),
  ...checked("hidden", pickField(updates.hidden, existing.hidden)),
  non_transferable: flagChoice(
    pickField(updates.nonTransferable, existing.non_transferable),
  ),
  ...checked(
    "purchase_only",
    pickField(updates.purchaseOnly, existing.purchase_only),
  ),
  ...checked(
    "use_defaults",
    pickField(updates.useDefaults, existing.use_defaults),
  ),
  ...checked(
    "uses_logistics",
    pickField(updates.usesLogistics, existing.uses_logistics),
  ),
});

const buildUpdateNumericFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): TestFormValues => {
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
    min_quantity: String(pickField(updates.minQuantity, existing.min_quantity)),
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
): TestFormValues => ({
  bookable_days: pickField(updates.bookableDays, existing.bookable_days),
  description: pickField(updates.description, existing.description),
  fields: repeated(pickField(updates.fields, existing.fields)),
  listing_type: pickField(updates.listingType, existing.listing_type),
  location: pickField(updates.location, existing.location),
  name: pickField(updates.name, existing.name),
  slug: pickField(updates.slug, existing.slug),
  thank_you_url: formatOptional(updates.thankYouUrl, existing.thank_you_url),
  webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
});

export const buildUpdateListingForm = (
  updates: Partial<ListingInput> & { assignUndatedTo?: string },
  existing: ListingWithCount,
  adminLevel: AdminLevel = "owner",
): TestFormValues => {
  const closesAtParts = splitClosesAt(updates.closesAt, existing.closes_at);
  const dateParts = splitClosesAt(updates.date, existing.date);
  return pageBoxes(
    {
      ...buildUpdateBoolFields(updates, existing),
      ...buildUpdateNumericFields(updates, existing),
      ...buildUpdateStringFields(updates, existing),
      ...dayPriceFormFields(updates.dayPrices ?? existing.day_prices),
      closes_at_date: closesAtParts.date,
      closes_at_time: closesAtParts.time,
      ...checked(
        "customisable_days",
        updates.customisableDays ?? existing.customisable_days,
      ),
      date_date: dateParts.date,
      date_time: dateParts.time,
      // A switch that must date undated bookings first carries the organiser's
      // chosen day under this field; the save then moves them and flips.
      ...(updates.assignUndatedTo === undefined
        ? {}
        : { assign_undated_to: updates.assignUndatedTo }),
    },
    adminLevel,
  );
};
