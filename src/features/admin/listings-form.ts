/**
 * Listing form parsing and resource builders.
 *
 * Turns the raw create/edit form into a {@link ListingInput}, and wraps the
 * shared listing fields into per-request create/update REST resources so the
 * dynamic `day_price_*` inputs can be read alongside the validated values.
 */

/* jscpd:ignore-start */
import { isBuilderEnabled } from "#routes/admin/builder.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { normalizeDatetime } from "#shared/dates.ts";
import {
  computeSlugIndex,
  type ListingAggregateValues,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { isDemoMode } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms.tsx";
import {
  generateUniqueListingSlug,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { defineResource } from "#shared/rest/resource.ts";
import { normalizeSlug } from "#shared/slug.ts";
import {
  type DayPrices,
  type ListingType,
  parseDayPrices,
} from "#shared/types.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import type {
  ListingAggregateFormValues,
  ListingEditFormValues,
  ListingFormValues,
} from "#templates/fields.ts";
import {
  getAssignBuiltSiteField,
  getGroupIdField,
  getInitialSiteMonthsField,
  getListingFields,
  getMonthsPerUnitField,
  getSlugField,
  splitCsv,
} from "#templates/fields.ts";

/* jscpd:ignore-end */

type ListingWriteMode = "create" | "update";
type EmptyBookableDaysPolicy = "defaultAllDays" | "preserveEmpty";

const DEFAULT_LISTING_TYPE: ListingType = "standard";

const EMPTY_BOOKABLE_DAYS_POLICY = {
  create: {
    daily: "defaultAllDays",
    standard: "defaultAllDays",
  },
  update: {
    daily: "preserveEmpty",
    standard: "defaultAllDays",
  },
} as const satisfies Record<
  ListingWriteMode,
  Record<ListingType, EmptyBookableDaysPolicy>
>;

const resolveListingType = (
  value: ListingFormValues["listing_type"],
): ListingType => value || DEFAULT_LISTING_TYPE;

/** Parse comma-separated day names, applying the submit-mode empty selection policy. */
const parseBookableDays = (
  value: string,
  listingType: ListingType,
  mode: ListingWriteMode,
): string[] | undefined => {
  const days = splitCsv(value);
  if (days.length > 0) return days;
  return EMPTY_BOOKABLE_DAYS_POLICY[mode][listingType] === "preserveEmpty"
    ? days
    : undefined;
};

/**
 * Read the per-day-count price inputs (`day_price_1`, `day_price_2`, …) from
 * the raw form into a {@link DayPrices} map. Only days 1..maxDays are read
 * (matching the inputs the form renders); blank rows are skipped so that count
 * isn't offered. {@link parseDayPrices} drops any non-numeric entries.
 */
const parseDayPricesFromForm = (
  form: FormParams,
  maxDays: number,
): DayPrices => {
  const result: DayPrices = {};
  for (let n = 1; n <= maxDays; n++) {
    // Optional per-day price: blank ⇒ skip (that day isn't offered). A non-blank
    // value that fails to parse is caught by validateDayPricesFromForm before
    // the save, so here a null result is only ever a blank.
    const price = parseOptionalMinorUnits(form.getString(`day_price_${n}`));
    if (price !== null) result[n] = price;
  }
  return parseDayPrices(result);
};

/**
 * Reject the save when a `day_price_*` field carries a non-blank value that
 * isn't a valid amount for the currency (e.g. `10.005` in GBP, `10.5` in JPY, or
 * `abc`). Without this, an invalid value would be silently dropped by
 * {@link parseDayPricesFromForm} — on an update that would remove an existing
 * day price rather than surfacing the error. Blank fields are skipped (that
 * duration simply isn't offered). Returns an error message, or null when every
 * present day price is valid. These dynamic fields aren't part of the static
 * field schema, so they're validated here through the resource's `validate` hook.
 */
const validateDayPricesFromForm = (form: FormParams): string | null => {
  const hasInvalid = [...form.entries()].some(
    ([field, raw]) =>
      field.startsWith("day_price_") &&
      raw.trim() !== "" &&
      parseOptionalMinorUnits(raw) === null,
  );
  return hasInvalid
    ? "Enter a valid day price for each duration, or leave it blank."
    : null;
};

/** Normalize an optional datetime field to UTC, passing through blanks/undefined. */
const normalizeOptionalDatetime = (
  raw: string | undefined,
  field: string,
): string | undefined => (raw ? normalizeDatetime(raw, field) : raw);

/** Extract common listing fields from validated form values, normalizing datetimes to UTC */
const extractCommonFields = (
  values: ListingFormValues,
  form: FormParams,
  mode: ListingWriteMode,
) => {
  const webhookUrl = isDemoMode() ? "" : values.webhook_url || "";
  const durationDays = values.duration_days ?? 1;
  const listingType = resolveListingType(values.listing_type);
  // Blank/invalid unit price ⇒ unset (the column defaults to 0 = free); a valid
  // value is the currency-checked minor-units amount. `unit_price` is always a
  // string here, so no nullish fallback is needed before parsing.
  const unitPrice = parseOptionalMinorUnits(values.unit_price) ?? undefined;
  const bookableDays = parseBookableDays(
    values.bookable_days,
    listingType,
    mode,
  );
  const closesAt = normalizeOptionalDatetime(values.closes_at, "closes_at");
  return {
    assignBuiltSite: isBuilderEnabled() && values.assign_built_site === "1",
    bookableDays,
    canPayMore: values.can_pay_more === "1",
    closesAt,
    customisableDays: values.customisable_days === "1",
    date: normalizeOptionalDatetime(values.date, "date") ?? "",
    dayPrices: parseDayPricesFromForm(form, durationDays),
    description: values.description,
    durationDays,
    fields: values.fields || "",
    groupId: Number(values.group_id) || 0,
    hidden: values.hidden === "1",
    initialSiteMonths: Number(values.initial_site_months) || 0,
    listingType,
    location: values.location,
    maxAttendees: values.max_attendees,
    maximumDaysAfter: values.maximum_days_after ?? 90,
    maxPrice: toMinorUnits(Number.parseFloat(values.max_price)),
    maxQuantity: values.max_quantity,
    minimumDaysBefore: values.minimum_days_before ?? 1,
    monthsPerUnit: Number(values.months_per_unit) || 0,
    name: values.name,
    nonTransferable: values.non_transferable === "1",
    purchaseOnly: values.purchase_only === "1",
    thankYouUrl: values.thank_you_url || "",
    unitPrice,
    useDefaults: form.getString("use_defaults") === "1",
    usesLogistics:
      settings.hasLogistics && form.getString("uses_logistics") === "1",
    webhookUrl,
  };
};

/** Extract listing input from validated form (async to compute slugIndex) */
const extractListingInput = async (
  values: ListingFormValues,
  form: FormParams,
): Promise<ListingInput> => {
  const { slug, slugIndex } = await generateUniqueListingSlug();
  return {
    ...extractCommonFields(values, form, "create"),
    slug,
    slugIndex,
  };
};

/** Extract listing input for update (reads slug from form, normalizes it) */
const extractListingUpdateInput = async (
  values: ListingEditFormValues,
  form: FormParams,
): Promise<ListingInput> => {
  const slug = normalizeSlug(values.slug);
  const slugIndex = await computeSlugIndex(slug);
  return {
    ...extractCommonFields(values, form, "update"),
    slug,
    slugIndex,
  };
};

export const extractListingAggregateValues = (
  values: ListingAggregateFormValues,
): ListingAggregateValues => ({
  booked_quantity: values.booked_quantity,
  tickets_count: values.tickets_count,
});

/** Build listing resource fields for every create/update. */
const buildListingResourceFields = (): Field[] => [
  ...getListingFields(),
  getMonthsPerUnitField(),
  getInitialSiteMonthsField(),
  getAssignBuiltSiteField(),
  getGroupIdField(),
];

/**
 * Build a per-request listings create resource whose `toInput` closes over the
 * raw form, so the dynamic `day_price_*` inputs can be read alongside the
 * validated fields (the resource only hands `toInput` the validated values).
 */
/** The listing validation for a request: reject an invalid day price first
 *  (the dynamic fields the static schema can't see), then the standard input
 *  validation. Closes over the raw `form` so both create and update share it. */
const listingValidate =
  (form: FormParams) =>
  async (input: ListingInput, id?: number): Promise<string | null> =>
    validateDayPricesFromForm(form) ?? (await validateListingInput(input, id));

export const buildCreateListingResource = (form: FormParams) =>
  defineResource({
    fields: buildListingResourceFields(),
    nameField: "name",
    table: listingsTable,
    toInput: (values: ListingFormValues) => extractListingInput(values, form),
    validate: listingValidate(form),
  });

/** Build a per-request listings update resource (includes the slug field). */
export const buildUpdateListingResource = (form: FormParams) =>
  defineResource({
    fields: [...buildListingResourceFields(), getSlugField()],
    nameField: "name",
    table: listingsTable,
    toInput: (values: ListingEditFormValues) =>
      extractListingUpdateInput(values, form),
    validate: listingValidate(form),
  });
