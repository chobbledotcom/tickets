import { t } from "#i18n";
import { ADDRESS_LOOKUP_PROVIDERS } from "#shared/address-lookup/providers.ts";
import {
  ADDRESS_LOOKUP_SETTINGS,
  type AddressLookupSetting,
} from "#shared/address-lookup/types.ts";
import type { SettingsFormConfig } from "#shared/settings/form-schema.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { configurableTableLayouts } from "#shared/tables/configurable.ts";

const form = <const Definition extends SettingsFormConfig>(
  definition: Definition,
): Definition => definition;

/** The "Available tags: …" note under a column-order field, listing every
 *  Liquid tag the table understands. */
const availableTags = (layout: { keys: readonly string[] }): string =>
  `${t("settings.column_order.available")} ${layout.keys
    .map((key) => `{{${key}}}`)
    .join(", ")}`;

/** Picklist label: "none" is translated copy, real providers show their
 *  brand. */
const addressProviderLabel = (provider: AddressLookupSetting): string =>
  provider === "none"
    ? t("address_lookup.settings.provider_none")
    : ADDRESS_LOOKUP_PROVIDERS[provider].label;

export const SETTINGS_FORM_DEFINITIONS = [
  form({
    action: "/admin/settings/business-email",
    copy: {
      descriptionKey: "settings.business_email_hint",
      labelKey: "settings.business_email",
      placeholderKey: "settings.business_email_placeholder",
      submitLabelKey: "settings.save_business_email",
      titleKey: "settings.business_email",
    },
    fieldName: "business_email",
    formId: "settings-business-email",
    inputType: "email",
    key: CONFIG_KEYS.BUSINESS_EMAIL,
    kind: "text",
    name: "businessEmail",
    page: "main",
    routeLabel: "Business email",
    stateField: "businessEmail",
  }),
  form({
    action: "/admin/settings/theme",
    copy: {
      descriptionKey: "settings.theme_hint",
      submitLabelKey: "settings.save_theme",
      titleKey: "settings.theme",
    },
    fields: [
      {
        fieldName: "theme",
        kind: "radios",
        options: [
          { labelKey: "settings.theme_light", value: "light" },
          { labelKey: "settings.theme_dark", value: "dark" },
        ],
        stateField: "theme",
      },
      {
        fieldName: "underline_links",
        hintKey: "settings.underline_links_hint",
        kind: "checkbox",
        labelClass: "checkbox",
        labelKey: "settings.underline_links",
        stateField: "underlineLinks",
      },
    ],
    formId: "settings-theme",
    kind: "fields",
    name: "theme",
    page: "main",
    routeLabel: "Site theme",
  }),
  form({
    action: "/admin/settings/calendar-feeds",
    copy: {
      descriptionHtml: true,
      descriptionKey: "settings.calendar_feeds_hint",
      submitLabelKey: "settings.save_calendar_feeds",
      titleKey: "settings.calendar_feeds",
    },
    fields: [
      {
        fieldName: "calendar_feeds_enabled",
        kind: "checkbox",
        labelKey: "settings.calendar_feeds_enabled",
        stateField: "calendarFeedsEnabled",
      },
      {
        fieldName: "calendar_feeds_group_by",
        kind: "select",
        labelFor: true,
        labelKey: "settings.calendar_feeds_group_by",
        options: [
          {
            labelKey: "settings.calendar_feeds_group_by_attendees",
            value: "attendees",
          },
          {
            labelKey: "settings.calendar_feeds_group_by_listings",
            value: "listings",
          },
        ],
        stateField: "calendarFeedsGroupBy",
      },
    ],
    formId: "settings-calendar-feeds",
    kind: "fields",
    name: "calendarFeeds",
    page: "main",
    routeLabel: "Calendar feeds",
  }),
  form({
    action: "/admin/settings/terms",
    copy: {
      descriptionKey: "settings.terms_hint",
      labelHint: "formatting",
      labelKey: "settings.terms",
      placeholderKey: "settings.terms_placeholder",
      submitLabelKey: "settings.save_terms",
      titleKey: "settings.terms",
    },
    fieldName: "terms_and_conditions",
    formId: "settings-terms",
    key: CONFIG_KEYS.TERMS_AND_CONDITIONS,
    kind: "textarea",
    markdownPreview: true,
    name: "terms",
    page: "main",
    routeLabel: "Terms and conditions",
    stateField: "termsAndConditions",
  }),
  form({
    action: "/admin/settings/embed-hosts",
    copy: {
      descriptionKey: "settings.embed_hosts_hint",
      footerKey: "settings.embed_hosts_wildcard_hint",
      labelKey: "settings.embed_hosts_label",
      placeholderKey: "settings.embed_hosts_placeholder",
      submitLabelKey: "settings.save_embed_hosts",
      titleKey: "settings.embed_hosts",
    },
    fieldName: "embed_hosts",
    formId: "settings-embed-hosts",
    inputType: "text",
    key: CONFIG_KEYS.EMBED_HOSTS,
    kind: "text",
    name: "embedHosts",
    page: "main",
    routeLabel: "Embed host restrictions",
    stateField: "embedHosts",
  }),
  form({
    action: "/admin/settings/booking-fee",
    copy: {
      descriptionKey: "settings.booking_fee_hint",
      labelKey: "settings.booking_fee_label",
      submitLabelKey: "settings.save_booking_fee",
      titleKey: "settings.booking_fee",
    },
    fieldName: "booking_fee",
    formId: "settings-booking-fee",
    inputType: "number",
    key: CONFIG_KEYS.BOOKING_FEE,
    kind: "text",
    max: "10",
    min: "0",
    name: "bookingFee",
    page: "main",
    required: true,
    routeLabel: "Booking fee",
    stateField: "bookingFee",
    step: "0.1",
  }),
  form({
    action: "/admin/settings/listing-column-order",
    copy: {
      descriptionHtml: true,
      descriptionKey: "settings.column_order.listing_desc",
      footerText: () => availableTags(configurableTableLayouts.listing),
      labelKey: "settings.column_order.label",
      placeholderText: () => configurableTableLayouts.listing.defaultTemplate,
      submitLabelKey: "settings.column_order.listing_submit",
      titleKey: "settings.column_order.listing_title",
    },
    fieldName: "column_order",
    formId: "settings-listing-column-order",
    inputType: "text",
    key: CONFIG_KEYS.LISTING_COLUMN_ORDER,
    kind: "text",
    name: "listingColumnOrder",
    page: "advanced",
    routeLabel: "Listing column order",
    stateField: "listingColumnOrder",
    valueFallback: "placeholder",
  }),
  form({
    action: "/admin/settings/attendee-column-order",
    copy: {
      descriptionHtml: true,
      descriptionKey: "settings.column_order.attendee_desc",
      footerText: () => availableTags(configurableTableLayouts.attendee),
      labelKey: "settings.column_order.label",
      placeholderText: () => configurableTableLayouts.attendee.defaultTemplate,
      submitLabelKey: "settings.column_order.attendee_submit",
      titleKey: "settings.column_order.attendee_title",
    },
    fieldName: "column_order",
    formId: "settings-attendee-column-order",
    inputType: "text",
    key: CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
    kind: "text",
    name: "attendeeColumnOrder",
    page: "advanced",
    routeLabel: "Attendee column order",
    stateField: "attendeeColumnOrder",
    valueFallback: "placeholder",
  }),
  form({
    action: "/admin/settings/custom-css",
    copy: {
      descriptionKey: "settings.advanced.custom_css_hint",
      labelKey: "settings.advanced.custom_css_label",
      placeholderKey: "settings.advanced.custom_css_placeholder",
      submitLabelKey: "settings.advanced.save_custom_css",
      titleKey: "settings.advanced.custom_css",
    },
    fieldName: "custom_css",
    formId: "settings-custom-css",
    key: CONFIG_KEYS.CUSTOM_CSS,
    kind: "textarea",
    name: "customCss",
    page: "advanced",
    routeLabel: "Custom CSS",
    stateField: "customCss",
  }),
  form({
    action: "/admin/settings/show-public-api",
    copy: {
      descriptionHtml: true,
      descriptionKey: "settings.advanced.public_api_hint",
      titleKey: "settings.advanced.public_api",
    },
    fieldName: "show_public_api",
    formId: "settings-show-public-api",
    key: CONFIG_KEYS.SHOW_PUBLIC_API,
    kind: "boolean",
    name: "showPublicApi",
    page: "advanced",
    routeLabel: "Public API",
    stateField: "showPublicApi",
  }),
  form({
    action: "/admin/settings/address-lookup",
    copy: {
      descriptionHtml: "block",
      descriptionKey: "address_lookup.settings.description",
      submitLabelKey: "address_lookup.settings.save",
      titleKey: "address_lookup.settings.title",
    },
    fields: [
      {
        fieldName: "address_lookup_provider",
        kind: "select",
        labelKey: "address_lookup.settings.provider",
        options: () =>
          ADDRESS_LOOKUP_SETTINGS.map((provider) => ({
            label: addressProviderLabel(provider),
            value: provider,
          })),
        stateField: "addressLookupProvider",
      },
      {
        configuredStateField: "addressLookupApiKeyConfigured",
        fieldName: "address_lookup_api_key",
        kind: "secret",
        labelKey: "address_lookup.settings.api_key",
        placeholderKey: "address_lookup.settings.api_key_placeholder",
      },
    ],
    formId: "settings-address-lookup",
    kind: "fields",
    name: "addressLookup",
    page: "advanced",
    routeLabel: "Address lookup",
  }),
  form({
    action: "/admin/settings/external-order",
    copy: {
      descriptionKey: "settings.advanced.external_order_hint",
      titleKey: "settings.advanced.external_order",
    },
    fieldName: "external_order_enabled",
    formId: "settings-external-order",
    key: CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
    kind: "boolean",
    name: "externalOrder",
    page: "advanced",
    routeLabel: "External order buttons",
    stateField: "externalOrderEnabled",
  }),
] as const;

type SettingsFormDefinition = (typeof SETTINGS_FORM_DEFINITIONS)[number];
type SettingsFormName = SettingsFormDefinition["name"];

type SettingFormFor<Name extends SettingsFormName> = Extract<
  SettingsFormDefinition,
  { name: Name }
>;

type SettingsFormsByName = {
  readonly [Name in SettingsFormName]: SettingFormFor<Name>;
};

export const SETTINGS_FORMS = Object.fromEntries(
  SETTINGS_FORM_DEFINITIONS.map((definition) => [definition.name, definition]),
) as SettingsFormsByName;
