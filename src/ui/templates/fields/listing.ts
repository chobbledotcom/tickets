/**
 * Listing form field definitions plus the per-listing field builders shared
 * with the group and add-attendee forms.
 */

import { t } from "#i18n";
import { formatCurrency, getDecimalPlaces } from "#shared/currency.ts";
import { VALID_DAY_NAMES } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import type { Field } from "#shared/forms.tsx";
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
  validateBookableDays,
  validateDatetime,
  validateHttpsDomainUrl,
  validateListingFields,
  validateListingType,
  validateNonNegativePrice,
} from "#templates/fields/validators.ts";

/**
 * Listing form field definitions (per-request builder, shared between create and edit)
 */
export const getListingFields = (): Field[] => [
  {
    hint: t("fields.listing.name_hint"),
    label: t("fields.listing.name"),
    name: "name",
    placeholder: t("fields.listing.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    hint: t("fields.listing.type_hint"),
    label: t("fields.listing.type"),
    name: "listing_type",
    options: picklistOptions(ListingTypeSchema, "fields.listing.type"),
    type: "select",
    validate: validateListingType,
  },
  buildDescriptionField(
    t("fields.listing.description_hint_field"),
    formattingHint(),
  ),
  {
    hint: t("fields.listing.date_hint"),
    label: t("fields.listing.date"),
    name: "date",
    type: "datetime",
    validate: validateDatetime,
  },
  {
    hint: t("fields.listing.location_hint"),
    label: t("fields.listing.location"),
    name: "location",
    placeholder: t("fields.listing.location_placeholder"),
    type: "text",
  },
  {
    hint: t("fields.listing.max_attendees_hint"),
    label: t("fields.listing.max_attendees"),
    min: 1,
    name: "max_attendees",
    required: true,
    type: "number",
  },
  {
    hint: t("fields.listing.max_quantity_hint"),
    label: t("fields.listing.max_quantity"),
    min: 1,
    name: "max_quantity",
    required: true,
    type: "number",
  },
  {
    hint: t("fields.listing.bookable_days_hint"),
    label: t("fields.listing.bookable_days"),
    name: "bookable_days",
    options: VALID_DAY_NAMES.map((d) => ({ label: d, value: d })),
    type: "checkbox-group",
    validate: validateBookableDays,
  },
  {
    hint: t("fields.listing.min_days_notice_hint"),
    label: t("fields.listing.min_days_notice"),
    min: 0,
    name: "minimum_days_before",
    type: "number",
  },
  {
    hint: t("fields.listing.max_days_ahead_hint"),
    label: t("fields.listing.max_days_ahead"),
    min: 0,
    name: "maximum_days_after",
    type: "number",
  },
  {
    hint: t("fields.listing.duration_days_hint"),
    label: t("fields.listing.duration_days"),
    max: MAX_DURATION_DAYS,
    min: 1,
    name: "duration_days",
    type: "number",
    validate: (value: string): string | null => {
      // validateSingleField only calls this when the value is non-empty, so
      // the empty-string case never reaches here.
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        return t("fields.validation.duration_whole");
      }
      if (parsed < 1) return t("fields.validation.duration_min");
      if (parsed > MAX_DURATION_DAYS) {
        return t("fields.validation.duration_max", { max: MAX_DURATION_DAYS });
      }
      return null;
    },
  },
  {
    hint: t("fields.listing.customisable_days_hint"),
    label: t("fields.listing.customisable_days"),
    name: "customisable_days",
    options: [
      { label: t("fields.listing.customisable_days_label"), value: "1" },
    ],
    type: "checkbox-group",
  },
  {
    hint: t("fields.listing.contact_fields_hint"),
    hintHtml: t("fields.listing.contact_fields_hint_html"),
    label: t("fields.listing.contact_fields"),
    name: "fields",
    options: picklistOptions(ContactFieldSchema, "fields.listing.contact"),
    type: "checkbox-group",
    validate: validateListingFields,
  },
  {
    inputmode: "decimal",
    label: t("fields.listing.price"),
    name: "unit_price",
    pattern: moneyPattern(),
    placeholder: t("fields.listing.price_placeholder"),
    title: t("fields.listing.price_title"),
    type: "text",
    validate: validateNonNegativePrice,
  },
  {
    hint: t("fields.listing.allow_pay_more_hint"),
    label: t("fields.listing.allow_pay_more"),
    name: "can_pay_more",
    options: [{ label: t("fields.listing.allow_pay_more_label"), value: "1" }],
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
    title: t("fields.listing.max_price_title"),
    type: "text",
    validate: validateNonNegativePrice,
  },
  {
    hint: t("fields.listing.registration_closes_hint"),
    label: t("fields.listing.registration_closes"),
    name: "closes_at",
    type: "datetime",
    validate: validateDatetime,
  },
  {
    hint: t("fields.listing.thank_you_url_hint"),
    label: t("fields.listing.thank_you_url"),
    name: "thank_you_url",
    placeholder: "https://example.com/thank-you",
    type: "url",
    validate: validateHttpsDomainUrl,
  },
  {
    hint: t("fields.listing.webhook_url_hint"),
    label: t("fields.listing.webhook_url"),
    name: "webhook_url",
    placeholder: "https://example.com/webhook",
    type: "url",
    validate: validateHttpsDomainUrl,
  },
  {
    hint: t("fields.listing.non_transferable_hint"),
    label: t("fields.listing.non_transferable"),
    name: "non_transferable",
    options: [
      { label: t("fields.listing.non_transferable_no"), value: "" },
      { label: t("fields.listing.non_transferable_yes"), value: "1" },
    ],
    type: "select",
  },
  buildHiddenField("Listing"),
  checkboxField("purchase_only", {
    hint: t("fields.listing.purchase_only_hint"),
    label: t("fields.listing.purchase_only"),
    optionLabel: t("fields.listing.purchase_only_label"),
  }),
  checkboxField("bookable_alone", {
    hint: t("fields.listing.bookable_alone_hint"),
    label: t("fields.listing.bookable_alone"),
    optionLabel: t("fields.listing.bookable_alone_label"),
  }),
];

/**
 * "Needs logistics" listing toggle. Only assembled into the listing form when
 * the logistics feature is enabled (see the listing page builders); attendees
 * of a logistics listing carry start and end agents.
 */
export const logisticsField: Field = {
  hint: "Handled by an agent at the customer's location. Attendees gain start and end agent selectors (e.g. delivery/collection, set-up/teardown, or pickup/drop-off).",
  label: "Needs logistics",
  name: "uses_logistics",
  options: [{ label: "Assign agents to this listing's bookings", value: "1" }],
  type: "checkbox-group",
};

export const getMonthsPerUnitField = (): Field => ({
  hint: t("fields.listing.months_per_unit_hint"),
  label: t("fields.listing.months_per_unit"),
  max: 24,
  min: 0,
  name: "months_per_unit",
  type: "number",
});

export const getInitialSiteMonthsField = (): Field => ({
  hint: t("fields.listing.initial_site_months_hint"),
  label: t("fields.listing.initial_site_months"),
  max: 120,
  min: 0,
  name: "initial_site_months",
  type: "number",
});

/** Logistics agent form field definitions
 */
export const logisticsAgentFields: Field[] = [
  {
    label: "Agent Name",
    name: "name",
    placeholder: "Van 1",
    required: true,
    type: "text",
  },
];

/** Field for assign_built_site on listings (conditionally shown when CAN_BUILD_SITES is enabled) */
export const getAssignBuiltSiteField = (): Field => ({
  hint: t("fields.listing.assign_built_site_hint"),
  label: t("fields.listing.assign_built_site"),
  name: "assign_built_site",
  options: [{ label: t("fields.listing.assign_built_site_label"), value: "1" }],
  type: "checkbox-group",
});

/** Attachment upload field for listing forms (appended when storage is enabled) */
export const getAttachmentField = (): Field => ({
  label: t("fields.listing.attachment", {
    size: formatBytes(MAX_ATTACHMENT_SIZE),
  }),
  name: "attachment",
  type: "file",
});
