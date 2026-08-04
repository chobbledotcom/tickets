import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  SETTINGS_FORM_DEFINITIONS,
  SETTINGS_FORMS,
  type SettingsFormDefinition,
} from "#shared/settings/forms.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { allEnglishMessages } from "#test-utils/i18n.ts";

const en = await allEnglishMessages(["settings", "address-lookup", "sms"]);

type FormName = keyof typeof SETTINGS_FORMS;
type Page = "main" | "advanced";

/** Expected identity of a form that edits one setting via one field. */
const single = (
  name: FormName,
  page: Page,
  keyName: keyof typeof CONFIG_KEYS,
  kind: "boolean" | "text" | "textarea",
  action: string,
  formId: string,
  fieldName: string,
  routeLabel: string,
  stateField: string,
) => ({
  action,
  fieldName,
  formId,
  key: CONFIG_KEYS[keyName],
  kind,
  name,
  page,
  routeLabel,
  stateField,
});

/** Expected identity of a multi-field form saved by a hand-written route. */
const multi = (
  name: FormName,
  page: Page,
  action: string,
  formId: string,
  fieldNames: readonly string[],
  routeLabel: string,
) => ({
  action,
  fieldNames,
  formId,
  kind: "fields" as const,
  name,
  page,
  routeLabel,
});

const EXPECTED_FORM_ROWS = [
  single(
    "businessEmail",
    "main",
    "BUSINESS_EMAIL",
    "text",
    "/admin/settings/business-email",
    "settings-business-email",
    "business_email",
    "Business email",
    "businessEmail",
  ),
  multi(
    "theme",
    "main",
    "/admin/settings/theme",
    "settings-theme",
    ["theme", "underline_links"],
    "Site theme",
  ),
  single(
    "terms",
    "main",
    "TERMS_AND_CONDITIONS",
    "textarea",
    "/admin/settings/terms",
    "settings-terms",
    "terms_and_conditions",
    "Terms and conditions",
    "termsAndConditions",
  ),
  single(
    "embedHosts",
    "main",
    "EMBED_HOSTS",
    "text",
    "/admin/settings/embed-hosts",
    "settings-embed-hosts",
    "embed_hosts",
    "Embed host restrictions",
    "embedHosts",
  ),
  single(
    "bookingFee",
    "main",
    "BOOKING_FEE",
    "text",
    "/admin/settings/booking-fee",
    "settings-booking-fee",
    "booking_fee",
    "Booking fee",
    "bookingFee",
  ),
  single(
    "listingColumnOrder",
    "advanced",
    "LISTING_COLUMN_ORDER",
    "text",
    "/admin/settings/listing-column-order",
    "settings-listing-column-order",
    "column_order",
    "Listing column order",
    "listingColumnOrder",
  ),
  single(
    "attendeeColumnOrder",
    "advanced",
    "ATTENDEE_COLUMN_ORDER",
    "text",
    "/admin/settings/attendee-column-order",
    "settings-attendee-column-order",
    "column_order",
    "Attendee column order",
    "attendeeColumnOrder",
  ),
  single(
    "customCss",
    "advanced",
    "CUSTOM_CSS",
    "textarea",
    "/admin/settings/custom-css",
    "settings-custom-css",
    "custom_css",
    "Custom CSS",
    "customCss",
  ),
  single(
    "showPublicApi",
    "advanced",
    "SHOW_PUBLIC_API",
    "boolean",
    "/admin/settings/show-public-api",
    "settings-show-public-api",
    "show_public_api",
    "Public API",
    "showPublicApi",
  ),
  single(
    "externalOrder",
    "advanced",
    "EXTERNAL_ORDER_ENABLED",
    "boolean",
    "/admin/settings/external-order",
    "settings-external-order",
    "external_order_enabled",
    "External order buttons",
    "externalOrderEnabled",
  ),
];

/** The definition reduced to the same identity shape the tables above use. */
const definitionRow = (definition: SettingsFormDefinition) =>
  definition.kind === "fields"
    ? {
        action: definition.action,
        fieldNames: definition.fields.map((field) => field.fieldName),
        formId: definition.formId,
        kind: definition.kind,
        name: definition.name,
        page: definition.page,
        routeLabel: definition.routeLabel,
      }
    : {
        action: definition.action,
        fieldName: definition.fieldName,
        formId: definition.formId,
        key: definition.key,
        kind: definition.kind,
        name: definition.name,
        page: definition.page,
        routeLabel: definition.routeLabel,
        stateField: definition.stateField,
      };

const values = (field: "name" | "action" | "formId"): string[] =>
  SETTINGS_FORM_DEFINITIONS.map((definition) => String(definition[field]));

/** Every catalog key a field spec reads. */
const specCopyKeys = (definition: SettingsFormDefinition): string[] =>
  definition.kind === "fields"
    ? definition.fields.flatMap((spec) => [
        ...("labelKey" in spec ? [spec.labelKey] : []),
        ...("hintKey" in spec && spec.hintKey !== undefined
          ? [spec.hintKey]
          : []),
        ...("options" in spec
          ? spec.options.map((option) => option.labelKey)
          : []),
      ])
    : [];

const copyKeysFor = (definition: SettingsFormDefinition): (string | null)[] => [
  definition.copy.descriptionKey,
  "footerKey" in definition.copy ? definition.copy.footerKey : null,
  "labelKey" in definition.copy ? definition.copy.labelKey : null,
  "placeholderKey" in definition.copy ? definition.copy.placeholderKey : null,
  "submitLabelKey" in definition.copy ? definition.copy.submitLabelKey : null,
  definition.copy.titleKey,
  ...specCopyKeys(definition),
];

const copyKeys = (): string[] =>
  SETTINGS_FORM_DEFINITIONS.flatMap((definition) =>
    copyKeysFor(definition).filter((key): key is string => key !== null),
  );

describe("settings form schema", () => {
  test("declares the generated settings forms", () => {
    expect(SETTINGS_FORM_DEFINITIONS.map(definitionRow)).toEqual(
      EXPECTED_FORM_ROWS,
    );
  });

  test("indexes forms by name", () => {
    expect(Object.keys(SETTINGS_FORMS)).toEqual(
      EXPECTED_FORM_ROWS.map((row) => row.name),
    );
  });

  // Field names are deliberately not unique across forms: two forms may post
  // the same field name to different actions (e.g. both column-order forms
  // post "column_order").
  test("uses unique names, actions, and form ids", () => {
    for (const field of ["name", "action", "formId"] as const) {
      const all = values(field);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  test("uses unique field names within each multi-field form", () => {
    for (const definition of SETTINGS_FORM_DEFINITIONS) {
      if (definition.kind !== "fields") continue;
      const names = definition.fields.map((field) => field.fieldName);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("points every copy key at an existing locale string", () => {
    const messages = en as Record<string, string>;
    expect(copyKeys().filter((key) => !(key in messages))).toEqual([]);
  });
});
