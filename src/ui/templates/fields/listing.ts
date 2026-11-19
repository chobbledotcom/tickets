/**
 * Listing form field definitions plus the per-listing field builders shared
 * with the group and add-attendee forms.
 */

import { settings } from "#db/settings.ts";
import { t } from "#i18n";
import { formatCurrency, getDecimalPlaces } from "#shared/currency.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { formatBytes } from "#shared/format-units.ts";
import { defineFieldsForm, type FormValues } from "#shared/forms/definition.ts";
import {
  type ChoiceOptions,
  type Field,
  type InputField,
  requireChoiceOptions,
} from "#shared/forms/field.ts";
import { MAX_ATTACHMENT_SIZE } from "#shared/limits.ts";
import { LISTING_FIELDS } from "#shared/records/listing-fields.ts";
import { closedFieldsFor } from "#shared/records/write-access.ts";
import { type ClosedFields, fieldOfKey } from "#shared/rest/field-specs.ts";
import { isWholeNumberField } from "#shared/rest/field-values.ts";
import { isStorageEnabled } from "#shared/storage.ts";
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
  type AdminLevel,
  ContactFieldSchema,
  ListingTypeSchema,
  MAX_DURATION_DAYS,
} from "#types";

export interface ListingFormView {
  /** The fields this writer cannot set. The page hides their boxes. */
  closed: ClosedFields;
  nameAutofocus?: boolean;
  storage?: boolean;
}

/** A view that hides no field box, for a read of the box names. */
const OPEN_VIEW: ListingFormView = { closed: new Map() };

/** True when the page shows the box of this field. */
const shows = (view: ListingFormView, key: string): boolean =>
  !view.closed.has(key);

/** What the listing page shows to a writer of this level. */
export const listingFormView = (adminLevel: AdminLevel): ListingFormView => ({
  closed: closedFieldsFor(LISTING_FIELDS, adminLevel),
  storage: isStorageEnabled(),
});

type ListingNumberFieldOptions = Partial<
  Pick<
    InputField,
    "max" | "min" | "parse" | "required" | "validate" | "visible"
  >
>;

const LISTING_NUMBER_COPY = {
  durationDays: "duration_days",
  initialSiteMonths: "initial_site_months",
  maxAttendees: "max_attendees",
  maximumDaysAfter: "max_days_ahead",
  maxQuantity: "max_quantity",
  minimumDaysBefore: "min_days_notice",
  minQuantity: "min_quantity",
  monthsPerUnit: "months_per_unit",
} as const;

type ListingNumberFieldName = keyof typeof LISTING_NUMBER_COPY;
type ListingNumberField<
  TName extends ListingNumberFieldName,
  TSection extends string,
> = Omit<InputField<TName, TSection>, "section" | "type"> & {
  section: TSection;
  type: "number";
};

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
  return {
    ...copy,
    ...options,
    // A whole-number kind refuses a fraction on the form, the same rule the
    // API check enforces on the body value. The field's declared bounds stay
    // responsible for the range, and its message.
    ...(isWholeNumberField(fieldOfKey(LISTING_FIELDS, name)) &&
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
  other: "canPayMore" | "customisableDays",
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
const listingFields = (view: ListingFormView = OPEN_VIEW) =>
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
        "listingType",
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
    listingNumberField("maxAttendees", "tickets", {
      min: 1,
      required: true,
    }),
    listingNumberField("maxQuantity", "tickets", {
      min: 1,
      required: true,
    }),
    listingNumberField("minQuantity", "tickets", { min: 1 }),
    {
      hint: t("fields.listing.bookable_days_hint"),
      label: t("fields.listing.bookable_days"),
      name: "bookableDays",
      options: requireChoiceOptions(
        t("fields.listing.bookable_days"),
        VALID_DAY_NAMES.map((d) => ({ label: d, value: d })),
      ),
      section: "daily",
      type: "checkbox-group",
      validate: validateBookableDays,
    },
    listingNumberField("minimumDaysBefore", "daily", { min: 0 }),
    listingNumberField("maximumDaysAfter", "daily", { min: 0 }),
    listingNumberField("durationDays", "duration", {
      max: MAX_DURATION_DAYS,
      min: 1,
      // The declared min/max enforce the range, and a negative whole number
      // reaches them, so this check refuses only a non-integer shape.
      parse: parseSignedInt,
      validate: wholeNumberCheck(() => t("fields.validation.duration_whole")),
    }),
    payMoreOrDaysTick(
      "customisableDays",
      "customisable_days",
      "canPayMore",
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
    {
      ...ticketMoneyField("unitPrice", "price"),
      required: true,
      requiredMessage: t("fields.validation.unit_price_required"),
    },
    payMoreOrDaysTick(
      "canPayMore",
      "allow_pay_more",
      "customisableDays",
      "tickets",
    ),
    {
      ...ticketMoneyField("recurringPrice", "price"),
      hint: t("fields.listing.recurring_price_hint"),
      label: t("fields.listing.recurring_price"),
      visible: shows(view, "recurringPrice"),
    },
    {
      ...choiceField(
        "recurringInterval",
        "recurring_interval",
        blankThenPicklistOptions(
          t("fields.listing.recurring_interval_none"),
          RecurringIntervalSchema,
          "fields.listing.recurring_interval",
        ),
        "tickets",
        "select",
      ),
      visible: shows(view, "recurringInterval"),
    },
    {
      ...ticketMoneyField("maxPrice", "max_price"),
      // 100 currency units, formatted to the currency's decimals so the default
      // is valid for a zero-decimal currency (JPY "100") as well as GBP "100.00".
      defaultValue: (100).toFixed(getDecimalPlaces(settings.currency)),
      hint: t("fields.listing.max_price_hint", { amount: formatCurrency(100) }),
    },
    datetimeField("closesAt", "registration_closes", "tickets"),
    {
      hint: t("fields.listing.thank_you_url_hint"),
      label: t("fields.listing.thank_you_url"),
      name: "thankYouUrl",
      placeholder: "https://example.com/thank-you",
      section: "advanced",
      type: "url",
      validate: validateHttpsDomainUrl,
    },
    {
      hint: t("fields.listing.webhook_url_hint"),
      label: t("fields.listing.webhook_url"),
      name: "webhookUrl",
      placeholder: "https://example.com/webhook",
      section: "advanced",
      type: "url",
      validate: validateHttpsDomainUrl,
      visible: shows(view, "webhookUrl"),
    },
    {
      hint: t("fields.listing.non_transferable_hint"),
      label: t("fields.listing.non_transferable"),
      name: "nonTransferable",
      options: [
        { label: t("fields.listing.non_transferable_no"), value: "" },
        { label: t("fields.listing.non_transferable_yes"), value: "1" },
      ],
      section: "options",
      type: "select",
    },
    { ...buildHiddenField("Listing"), section: "options" },
    {
      ...checkboxField("purchaseOnly", {
        hint: t("fields.listing.purchase_only_hint"),
        label: t("fields.listing.purchase_only"),
        optionLabel: t("fields.listing.purchase_only_label"),
      }),
      section: "options",
    },
    {
      ...checkboxField("bookableAlone", {
        hint: t("fields.listing.bookable_alone_hint"),
        label: t("fields.listing.bookable_alone"),
        optionLabel: t("fields.listing.bookable_alone_label"),
      }),
      section: "options",
    },
    {
      hint: "Handled by an agent at the customer's location. Attendees gain start and end agent selectors (e.g. delivery/collection, set-up/teardown, or pickup/drop-off).",
      label: "Needs logistics",
      name: "usesLogistics",
      options: [
        { label: "Assign agents to this listing's bookings", value: "1" },
      ],
      section: "options",
      type: "checkbox-group",
      visible: shows(view, "usesLogistics"),
    },
    listingNumberField("monthsPerUnit", "advanced", {
      max: 24,
      min: 0,
      visible: shows(view, "monthsPerUnit"),
    }),
    listingNumberField("initialSiteMonths", "advanced", {
      max: 120,
      min: 0,
      visible: shows(view, "initialSiteMonths"),
    }),
    {
      ...checkboxField("assignBuiltSite", {
        hint: t("fields.listing.assign_built_site_hint"),
        label: t("fields.listing.assign_built_site"),
        optionLabel: t("fields.listing.assign_built_site_label"),
      }),
      section: "advanced",
      visible: shows(view, "assignBuiltSite"),
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

const listingEditFields = (view: ListingFormView = OPEN_VIEW) =>
  [...listingFields(view), { ...getSlugField(), section: "advanced" }] as const;

export const getListingEditForm = defineFieldsForm(listingEditFields);

export type ListingFormValues = FormValues<ReturnType<typeof getListingForm>>;
export type ListingEditFormValues = FormValues<
  ReturnType<typeof getListingEditForm>
>;
