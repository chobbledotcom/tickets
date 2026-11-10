/**
 * Listing form field definitions plus the per-listing field builders shared
 * with the group and add-attendee forms.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import {
  type CatalogField,
  isWholeNumberKind,
} from "#shared/catalog-fields/definition.ts";
import { listingCatalogFields } from "#shared/catalog-fields/fields.ts";
import { formatCurrency, getDecimalPlaces } from "#shared/currency.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { formatBytes } from "#shared/format-units.ts";
import {
  defineFieldsForm,
  defineForm,
  type FormValues,
} from "#shared/forms/definition.ts";
import {
  type ChoiceOptions,
  type Field,
  type InputField,
  requireChoiceOptions,
} from "#shared/forms/field.ts";
import { MAX_ATTACHMENT_SIZE } from "#shared/limits.ts";
import { RecurringIntervalSchema } from "#shared/subscriptions/plan.ts";
import { parseSignedInt } from "#shared/validation/number.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { moneyPattern } from "#templates/components/price-input.tsx";
import { checkboxField } from "#templates/fields/checkbox-field.ts";
import {
  blankThenPicklistOptions,
  picklistOptions,
} from "#templates/fields/picklist-options.ts";
import {
  buildDescriptionField,
  buildHiddenField,
  getSlugField,
  validateBookableDays,
  validateDatetime,
  validateHttpsDomainUrl,
  validateListingFields,
  validateNonNegativePrice,
  validateWholeNumber,
  wholeNumberCheck,
} from "#templates/fields/validators.ts";
import {
  ContactFieldSchema,
  ListingTypeSchema,
  MAX_DURATION_DAYS,
} from "#types";

export interface ListingFormView {
  builder?: boolean;
  logistics?: boolean;
  nameAutofocus?: boolean;
  storage?: boolean;
  subscriptions?: boolean;
  webhook?: boolean;
}

type ListingNumberFieldOptions = Partial<
  Pick<
    InputField,
    "max" | "min" | "parse" | "required" | "validate" | "visible"
  >
>;

const LISTING_NUMBER_COPY = {
  duration_days: "duration_days",
  initial_site_months: "initial_site_months",
  max_attendees: "max_attendees",
  max_quantity: "max_quantity",
  maximum_days_after: "max_days_ahead",
  min_quantity: "min_quantity",
  minimum_days_before: "min_days_notice",
  months_per_unit: "months_per_unit",
} as const;

type ListingNumberFieldName = keyof typeof LISTING_NUMBER_COPY;
type ListingNumberField<
  TName extends ListingNumberFieldName,
  TSection extends string,
> = Omit<InputField<TName, TSection>, "section" | "type"> & {
  section: TSection;
  type: "number";
};

/** The catalog entry behind each listing form number field, keyed by the
 *  submitted name. The entry's kind is the shared declaration the listing
 *  JSON API enforces on the same value. */
const CATALOG_FIELD_BY_NAME: Record<string, CatalogField> = Object.fromEntries(
  Object.values(listingCatalogFields).map((entry) => [entry[0], entry]),
);

/** The label and hint of a listing box, read from its `copy` keys. */
const fieldCopy = (copy: string): { hint: string; label: string } => ({
  hint: t(`fields.listing.${copy}_hint`),
  label: t(`fields.listing.${copy}`),
});

const listingNumberField = <
  TName extends ListingNumberFieldName,
  TSection extends string,
  TOptions extends ListingNumberFieldOptions,
>(
  name: TName,
  section: TSection,
  options: TOptions,
): ListingNumberField<TName, TSection> & TOptions => {
  const copy = fieldCopy(LISTING_NUMBER_COPY[name]);
  const catalogField = CATALOG_FIELD_BY_NAME[name];
  return {
    ...copy,
    ...options,
    // A whole-number kind refuses a fraction on the form, the same rule the
    // API check enforces on the body value. The field's declared bounds stay
    // responsible for the range, and its message.
    ...(catalogField !== undefined &&
    isWholeNumberKind(catalogField) &&
    options.validate === undefined
      ? { validate: validateWholeNumber(copy.label) }
      : {}),
    name,
    // Every listing number column is an integer, so the parser refuses a
    // malformed value (`1e3`, `5abc`, a fraction). The shape helper is not
    // spread here because the caller's own options decide the value type.
    parse: options.parse ?? parseSignedInt,
    section,
    type: "number",
  };
};

/** A money box in the tickets section. `copy` names its label, placeholder
 *  and title keys. */
const ticketMoneyField = <TName extends string>(
  name: TName,
  copy: "max_price" | "price",
) => ({
  inputmode: "decimal" as const,
  label: t(`fields.listing.${copy}`),
  name,
  pattern: moneyPattern(),
  placeholder: t(`fields.listing.${copy}_placeholder`),
  section: "tickets" as const,
  title: t(`fields.listing.${copy}_title`),
  type: "text" as const,
  validate: validateNonNegativePrice,
});

/** A date and time box. `copy` names its label and hint keys. */
const datetimeField = <TName extends string, TSection extends string>(
  name: TName,
  copy: "date" | "registration_closes",
  section: TSection,
) => ({
  ...fieldCopy(copy),
  name,
  section,
  type: "datetime" as const,
  validate: validateDatetime,
});

/** A box of choices. `copy` names its label and hint keys. */
const choiceField = <
  TName extends string,
  TSection extends string,
  TType extends "checkbox-group" | "select",
  TOptions extends ChoiceOptions,
>(
  name: TName,
  copy: string,
  options: TOptions,
  section: TSection,
  type: TType,
) => ({
  ...fieldCopy(copy),
  name,
  options,
  section,
  type,
});

/** Customisable days and pay-more pricing cannot both be on, so each tick
 *  names the other. `copy` names its label, hint and tick label keys. */
const payMoreOrDaysTick = <TName extends string, TSection extends string>(
  name: TName,
  copy: "allow_pay_more" | "customisable_days",
  other: "can_pay_more" | "customisable_days",
  section: TSection,
) => ({
  ...choiceField(
    name,
    copy,
    [{ label: t(`fields.listing.${copy}_label`), value: "1" }],
    section,
    "checkbox-group",
  ),
  exclusive: { other, why: t("error.customisable_days_with_pay_more") },
});

/** Listing fields and their sections, rebuilt per request for translated copy. */
const listingFields = (view: ListingFormView = {}) =>
  [
    {
      ...(view.nameAutofocus ? { autofocus: true } : {}),
      hint: t("fields.listing.name_hint"),
      label: t("fields.listing.name"),
      name: "name",
      placeholder: t("fields.listing.name_placeholder"),
      required: true,
      section: "basics",
      type: "text",
    },
    {
      ...choiceField(
        "listing_type",
        "type",
        picklistOptions(ListingTypeSchema, "fields.listing.type"),
        "basics",
        "select",
      ),
      invalidMessage: t("fields.validation.listing_type"),
    },
    {
      ...buildDescriptionField(
        t("fields.listing.description_hint_field"),
        formattingHint(),
      ),
      section: "basics",
    },
    datetimeField("date", "date", "basics"),
    {
      hint: t("fields.listing.location_hint"),
      label: t("fields.listing.location"),
      name: "location",
      placeholder: t("fields.listing.location_placeholder"),
      section: "basics",
      type: "text",
    },
    listingNumberField("max_attendees", "tickets", {
      min: 1,
      required: true,
    }),
    listingNumberField("max_quantity", "tickets", {
      min: 1,
      required: true,
    }),
    listingNumberField("min_quantity", "tickets", { min: 1 }),
    {
      hint: t("fields.listing.bookable_days_hint"),
      label: t("fields.listing.bookable_days"),
      name: "bookable_days",
      options: requireChoiceOptions(
        t("fields.listing.bookable_days"),
        VALID_DAY_NAMES.map((d) => ({ label: d, value: d })),
      ),
      section: "daily",
      type: "checkbox-group",
      validate: validateBookableDays,
    },
    listingNumberField("minimum_days_before", "daily", { min: 0 }),
    listingNumberField("maximum_days_after", "daily", { min: 0 }),
    listingNumberField("duration_days", "duration", {
      max: MAX_DURATION_DAYS,
      min: 1,
      // The declared min/max enforce the range, and a negative whole number
      // reaches them, so this check refuses only a non-integer shape.
      parse: parseSignedInt,
      validate: wholeNumberCheck(() => t("fields.validation.duration_whole")),
    }),
    payMoreOrDaysTick(
      "customisable_days",
      "customisable_days",
      "can_pay_more",
      "customisable",
    ),
    {
      ...choiceField(
        "fields",
        "contact_fields",
        picklistOptions(ContactFieldSchema, "fields.listing.contact"),
        "options",
        "checkbox-group",
      ),
      hintHtml: t("fields.listing.contact_fields_hint_html"),
      validate: validateListingFields,
    },
    ticketMoneyField("unit_price", "price"),
    payMoreOrDaysTick(
      "can_pay_more",
      "allow_pay_more",
      "customisable_days",
      "tickets",
    ),
    {
      ...ticketMoneyField("recurring_price", "price"),
      hint: t("fields.listing.recurring_price_hint"),
      label: t("fields.listing.recurring_price"),
      visible: view.subscriptions === true,
    },
    {
      ...choiceField(
        "recurring_interval",
        "recurring_interval",
        blankThenPicklistOptions(
          t("fields.listing.recurring_interval_none"),
          RecurringIntervalSchema,
          "fields.listing.recurring_interval",
        ),
        "tickets",
        "select",
      ),
      visible: view.subscriptions === true,
    },
    {
      ...ticketMoneyField("max_price", "max_price"),
      // 100 currency units, formatted to the currency's decimals so the default
      // is valid for a zero-decimal currency (JPY "100") as well as GBP "100.00".
      defaultValue: (100).toFixed(getDecimalPlaces(settings.currency)),
      hint: t("fields.listing.max_price_hint", { amount: formatCurrency(100) }),
    },
    datetimeField("closes_at", "registration_closes", "tickets"),
    {
      hint: t("fields.listing.thank_you_url_hint"),
      label: t("fields.listing.thank_you_url"),
      name: "thank_you_url",
      placeholder: "https://example.com/thank-you",
      section: "advanced",
      type: "url",
      validate: validateHttpsDomainUrl,
    },
    {
      hint: t("fields.listing.webhook_url_hint"),
      label: t("fields.listing.webhook_url"),
      name: "webhook_url",
      placeholder: "https://example.com/webhook",
      section: "advanced",
      type: "url",
      validate: validateHttpsDomainUrl,
      visible: view.webhook !== false,
    },
    {
      hint: t("fields.listing.non_transferable_hint"),
      label: t("fields.listing.non_transferable"),
      name: "non_transferable",
      options: [
        { label: t("fields.listing.non_transferable_no"), value: "" },
        { label: t("fields.listing.non_transferable_yes"), value: "1" },
      ],
      section: "options",
      type: "select",
    },
    { ...buildHiddenField("Listing"), section: "options" },
    {
      ...checkboxField("purchase_only", {
        hint: t("fields.listing.purchase_only_hint"),
        label: t("fields.listing.purchase_only"),
        optionLabel: t("fields.listing.purchase_only_label"),
      }),
      section: "options",
    },
    {
      ...checkboxField("bookable_alone", {
        hint: t("fields.listing.bookable_alone_hint"),
        label: t("fields.listing.bookable_alone"),
        optionLabel: t("fields.listing.bookable_alone_label"),
      }),
      section: "options",
    },
    {
      hint: "Handled by an agent at the customer's location. Attendees gain start and end agent selectors (e.g. delivery/collection, set-up/teardown, or pickup/drop-off).",
      label: "Needs logistics",
      name: "uses_logistics",
      options: [
        { label: "Assign agents to this listing's bookings", value: "1" },
      ],
      section: "options",
      type: "checkbox-group",
      visible: view.logistics === true,
    },
    listingNumberField("months_per_unit", "advanced", {
      max: 24,
      min: 0,
      visible: view.builder === true,
    }),
    listingNumberField("initial_site_months", "advanced", {
      max: 120,
      min: 0,
      visible: view.builder === true,
    }),
    {
      hint: t("fields.listing.assign_built_site_hint"),
      label: t("fields.listing.assign_built_site"),
      name: "assign_built_site",
      options: [
        { label: t("fields.listing.assign_built_site_label"), value: "1" },
      ],
      section: "advanced",
      type: "checkbox-group",
      visible: view.builder === true,
    },
    {
      label: t("fields.listing.attachment", {
        size: formatBytes(MAX_ATTACHMENT_SIZE),
      }),
      name: "attachment",
      section: "basics",
      type: "file",
      visible: view.storage === true,
    },
  ] as const satisfies readonly Field[];

export const getListingForm = defineFieldsForm(listingFields);

const listingEditFields = (view: ListingFormView = {}) =>
  [...listingFields(view), { ...getSlugField(), section: "advanced" }] as const;

export const getListingEditForm = defineFieldsForm(listingEditFields);

export type ListingFormValues = FormValues<ReturnType<typeof getListingForm>>;
export type ListingEditFormValues = FormValues<
  ReturnType<typeof getListingEditForm>
>;

/** Logistics agent form field definitions
 */
const logisticsAgentFields = [
  {
    label: t("logistics.agent_name"),
    name: "name",
    placeholder: "Van 1",
    required: true,
    type: "text",
  },
] as const satisfies readonly Field[];

export const logisticsAgentForm = defineForm({
  fields: logisticsAgentFields,
});
