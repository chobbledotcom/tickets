import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { escapeHtml } from "#jsx/escape-html.ts";
import { toMajorUnits } from "#shared/currency.ts";
import {
  booleanToCheckbox,
  entityToFieldValues,
  type FieldValues,
} from "#shared/forms/values.ts";
import {
  hasAnyListingDefault,
  type ListingDefaultField,
  type ListingDefaultKind,
  type ListingDefaults,
  listingDefaultFormClasses,
  setListingDefaultFields,
} from "#shared/listing-defaults.ts";
import type { ListingTemplate } from "#shared/listing-templates.ts";
import { utcToLocalInput } from "#shared/timezone.ts";
import { moneyPattern } from "#templates/components/price-input.tsx";
import { getListingForm } from "#templates/fields/listing.ts";
import {
  type AdminSession,
  clampDurationDays,
  type ListingWithCount,
} from "#types";
import { formatBookableDays } from "./helpers.ts";

const formatDatetimeLocal = (iso: string | null): string | null =>
  iso ? utcToLocalInput(iso, settings.timezone) : null;

export const renderDayPricesFieldset = (listing?: ListingWithCount): string => {
  const max = listing ? clampDurationDays(listing.duration_days) : 1;
  const prices = listing?.day_prices ?? {};
  const rows = Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => {
      const stored = prices[n];
      const value = stored !== undefined ? toMajorUnits(stored) : "";
      return (
        `<label>${t("listings_table.day_price_row_label", { n })}` +
        `<input type="text" inputmode="decimal" name="day_price_${n}" ` +
        `value="${escapeHtml(value)}" pattern="${moneyPattern()}" ` +
        `placeholder="${t("listings_table.day_price_placeholder")}" title="${t(
          "listings_table.day_price_input_title",
        )}" />` +
        "</label>"
      );
    })
    .join("");
  return (
    `<fieldset data-day-prices id="day-prices">` +
    `<legend>${t("listings_table.day_prices_legend")}</legend>` +
    `<p><small>${t("listings_table.day_prices_help")}</small></p>` +
    rows +
    "</fieldset>"
  );
};

const listingFieldFormatters: Partial<
  Record<keyof ListingWithCount, (e: ListingWithCount) => string | null>
> = {
  assign_built_site: (e) => booleanToCheckbox(e.assign_built_site),
  bookable_alone: (e) => booleanToCheckbox(e.bookable_alone),
  bookable_days: (e) => formatBookableDays(e.bookable_days),
  can_pay_more: (e) => booleanToCheckbox(e.can_pay_more),
  closes_at: (e) => formatDatetimeLocal(e.closes_at),
  customisable_days: (e) => booleanToCheckbox(e.customisable_days),
  date: (e) => (e.date ? formatDatetimeLocal(e.date) : null),
  hidden: (e) => booleanToCheckbox(e.hidden),
  initial_site_months: (e) =>
    e.initial_site_months ? String(e.initial_site_months) : "",
  max_price: (e) => toMajorUnits(e.max_price),
  months_per_unit: (e) => (e.months_per_unit ? String(e.months_per_unit) : ""),
  non_transferable: (e) => booleanToCheckbox(e.non_transferable),
  purchase_only: (e) => booleanToCheckbox(e.purchase_only),
  unit_price: (e) => (e.unit_price > 0 ? toMajorUnits(e.unit_price) : ""),
  uses_logistics: (e) => booleanToCheckbox(e.uses_logistics),
};

export const listingToFieldValues = (listing: ListingWithCount): FieldValues =>
  entityToFieldValues(
    listing,
    getListingForm().fields,
    listingFieldFormatters,
    {
      slug: listing.slug,
    },
  );

const KIND_FORMATTERS: Record<
  ListingDefaultKind,
  (value: ListingDefaults[keyof ListingDefaults]) => string
> = {
  bool: (value) => booleanToCheckbox(value as boolean),
  days: (value) => formatBookableDays(value as string[]),
  number: (value) => String(value),
  url: (value) => String(value),
};

const defaultFieldValue = (
  field: ListingDefaultField,
  value: ListingDefaults[keyof ListingDefaults],
): string => KIND_FORMATTERS[field.kind](value);

export const defaultsToFieldValues = (defaults: ListingDefaults): FieldValues =>
  Object.fromEntries(
    setListingDefaultFields(defaults).map((field) => [
      field.field,
      defaultFieldValue(field, defaults[field.key]),
    ]),
  );

export const listingFormClass = (template: ListingTemplate): string =>
  [
    "listing-form--templated",
    template.signature.daily !== undefined ? "listing-form--hide-type" : "",
    template.signature.dated === false ? "listing-form--hide-date" : "",
    template.signature.daily === false ? "listing-form--no-daily" : "",
  ]
    .filter(Boolean)
    .join(" ");

const listingFormClassFor = (
  template: ListingTemplate | null,
  defaults: ListingDefaults,
): string | undefined => {
  const classes = [
    template ? listingFormClass(template) : "",
    listingDefaultFormClasses(defaults),
  ]
    .filter(Boolean)
    .join(" ");
  return classes || undefined;
};

export const listingFormClassAttr = (
  template: ListingTemplate | null,
  defaults: ListingDefaults,
): { class?: string } => {
  const classes = listingFormClassFor(template, defaults);
  return classes ? { class: classes } : {};
};

export const showUseDefaultsToggle = (
  session: AdminSession,
  defaults: ListingDefaults,
): boolean => hasAnyListingDefault(defaults) && session.adminLevel !== "editor";
