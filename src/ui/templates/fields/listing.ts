/**
 * Listing form field definitions plus the per-listing field builders shared
 * with the group and add-attendee forms.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatCurrency, getDecimalPlaces } from "#shared/currency.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { settings } from "#shared/db/settings.ts";
import {
  defineForm,
  type FormDefinition,
  type FormValues,
} from "#shared/forms/definition.ts";
import {
  type Field,
  type InputField,
  requireChoiceOptions,
} from "#shared/forms/field.ts";
import { formatBytes, MAX_ATTACHMENT_SIZE } from "#shared/limits.ts";
import {
  ContactFieldSchema,
  ListingTypeSchema,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import { formattingHint } from "#templates/components/formatting-hint.ts";
import { moneyPattern } from "#templates/components/price-input.tsx";
import { checkboxField } from "#templates/fields/checkbox-field.ts";
import { picklistOptions } from "#templates/fields/picklist-options.ts";
import {
  buildDescriptionField,
  buildHiddenField,
  getSlugField,
  validateBookableDays,
  validateDatetime,
  validateHttpsDomainUrl,
  validateListingFields,
  validateNonNegativePrice,
} from "#templates/fields/validators.ts";

/* jscpd:ignore-end */

export interface ListingFormView {
  builder?: boolean;
  logistics?: boolean;
  nameAutofocus?: boolean;
  storage?: boolean;
  webhook?: boolean;
}

type ListingNumberFieldOptions = Partial<
  Pick<InputField, "max" | "min" | "required" | "validate" | "visible">
>;

const LISTING_NUMBER_COPY = {
  duration_days: "duration_days",
  initial_site_months: "initial_site_months",
  max_attendees: "max_attendees",
  max_quantity: "max_quantity",
  maximum_days_after: "max_days_ahead",
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

const listingNumberField = <
  TName extends ListingNumberFieldName,
  TSection extends string,
  TOptions extends ListingNumberFieldOptions,
>(
  name: TName,
  section: TSection,
  options: TOptions,
): ListingNumberField<TName, TSection> & TOptions => {
  const copy = LISTING_NUMBER_COPY[name];
  return {
    hint: t(`fields.listing.${copy}_hint`),
    label: t(`fields.listing.${copy}`),
    ...options,
    name,
    section,
    type: "number",
  };
};

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
      hint: t("fields.listing.type_hint"),
      invalidMessage: t("fields.validation.listing_type"),
      label: t("fields.listing.type"),
      name: "listing_type",
      options: picklistOptions(ListingTypeSchema, "fields.listing.type"),
      section: "basics",
      type: "select",
    },
    {
      ...buildDescriptionField(
        t("fields.listing.description_hint_field"),
        formattingHint(),
      ),
      section: "basics",
    },
    {
      hint: t("fields.listing.date_hint"),
      label: t("fields.listing.date"),
      name: "date",
      section: "basics",
      type: "datetime",
      validate: validateDatetime,
    },
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
      validate: (value: string): string | null => {
        // validateSingleField only calls this when the value is non-empty, so
        // the empty-string case never reaches here.
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) {
          return t("fields.validation.duration_whole");
        }
        if (parsed < 1) return t("fields.validation.duration_min");
        if (parsed > MAX_DURATION_DAYS) {
          return t("fields.validation.duration_max", {
            max: MAX_DURATION_DAYS,
          });
        }
        return null;
      },
    }),
    {
      hint: t("fields.listing.customisable_days_hint"),
      label: t("fields.listing.customisable_days"),
      name: "customisable_days",
      options: [
        { label: t("fields.listing.customisable_days_label"), value: "1" },
      ],
      section: "customisable",
      type: "checkbox-group",
    },
    {
      hint: t("fields.listing.contact_fields_hint"),
      hintHtml: t("fields.listing.contact_fields_hint_html"),
      label: t("fields.listing.contact_fields"),
      name: "fields",
      options: picklistOptions(ContactFieldSchema, "fields.listing.contact"),
      section: "options",
      type: "checkbox-group",
      validate: validateListingFields,
    },
    {
      inputmode: "decimal",
      label: t("fields.listing.price"),
      name: "unit_price",
      pattern: moneyPattern(),
      placeholder: t("fields.listing.price_placeholder"),
      section: "tickets",
      title: t("fields.listing.price_title"),
      type: "text",
      validate: validateNonNegativePrice,
    },
    {
      hint: t("fields.listing.allow_pay_more_hint"),
      label: t("fields.listing.allow_pay_more"),
      name: "can_pay_more",
      options: [
        { label: t("fields.listing.allow_pay_more_label"), value: "1" },
      ],
      section: "tickets",
      type: "checkbox-group",
    },
    {
      // 100 currency units, formatted to the currency's decimals so the default
      // is valid for a zero-decimal currency (JPY "100") as well as GBP "100.00".
      defaultValue: (100).toFixed(getDecimalPlaces(settings.currency)),
      hint: t("fields.listing.max_price_hint", { amount: formatCurrency(100) }),
      inputmode: "decimal",
      label: t("fields.listing.max_price"),
      name: "max_price",
      pattern: moneyPattern(),
      placeholder: t("fields.listing.max_price_placeholder"),
      section: "tickets",
      title: t("fields.listing.max_price_title"),
      type: "text",
      validate: validateNonNegativePrice,
    },
    {
      hint: t("fields.listing.registration_closes_hint"),
      label: t("fields.listing.registration_closes"),
      name: "closes_at",
      section: "tickets",
      type: "datetime",
      validate: validateDatetime,
    },
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

type ListingForm = FormDefinition<ReturnType<typeof listingFields>>;

export const getListingForm = (view: ListingFormView = {}): ListingForm =>
  defineForm({ fields: listingFields(view) });

const listingEditFields = (view: ListingFormView) =>
  [...listingFields(view), { ...getSlugField(), section: "advanced" }] as const;

type ListingEditForm = FormDefinition<ReturnType<typeof listingEditFields>>;

export const getListingEditForm = (
  view: ListingFormView = {},
): ListingEditForm => defineForm({ fields: listingEditFields(view) });

export type ListingFormValues = FormValues<ListingForm>;
export type ListingEditFormValues = FormValues<ListingEditForm>;

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
