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
import { clampDurationDays, type ListingWithCount } from "#types";
import { formatBookableDays } from "./helpers.ts";

const formatDatetimeLocal = (iso: string | null): string | null =>
  iso ? utcToLocalInput(iso, settings.timezone) : null;

export const renderDayPricesFieldset = (listing?: ListingWithCount): string => {
  const max = listing ? clampDurationDays(listing.durationDays) : 1;
  const prices = listing?.dayPrices ?? {};
  const rows = Array.from({ length: max }, (_, i) => i + 1)
    .map((n) => {
      const stored = prices[n];
      const value = stored !== undefined ? toMajorUnits(stored) : "";
      return (
        `<label>${t("listings_table.day_price_row_label", { n })}` +
        `<input type="text" inputmode="decimal" name="dayPrice${n}" ` +
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
  bookableDays: (e) => formatBookableDays(e.bookableDays),
  closesAt: (e) => formatDatetimeLocal(e.closesAt),
  date: (e) => (e.date ? formatDatetimeLocal(e.date) : null),
  initialSiteMonths: (e) =>
    e.initialSiteMonths ? String(e.initialSiteMonths) : "",
  maxPrice: (e) => toMajorUnits(e.maxPrice),
  monthsPerUnit: (e) => (e.monthsPerUnit ? String(e.monthsPerUnit) : ""),
  recurringPrice: (e) =>
    e.recurringPrice > 0 ? toMajorUnits(e.recurringPrice) : "",
  unitPrice: (e) => toMajorUnits(e.unitPrice),
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
