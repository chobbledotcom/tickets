import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import en from "#locales/en/index.ts";
import {
  SETTINGS_FORM_DEFINITIONS,
  SETTINGS_FORMS,
} from "#shared/settings/forms.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";

type ExpectedFormRow = readonly [
  keyof typeof SETTINGS_FORMS,
  "main" | "advanced",
  keyof typeof CONFIG_KEYS,
  "boolean" | "text" | "textarea",
  string,
  string,
  string,
  string,
  string,
];

const EXPECTED_FORM_ROWS = [
  [
    "businessEmail",
    "main",
    "BUSINESS_EMAIL",
    "text",
    "/admin/settings/business-email",
    "settings-business-email",
    "business_email",
    "Business email",
    "businessEmail",
  ],
  [
    "terms",
    "main",
    "TERMS_AND_CONDITIONS",
    "textarea",
    "/admin/settings/terms",
    "settings-terms",
    "terms_and_conditions",
    "Terms and conditions",
    "termsAndConditions",
  ],
  [
    "embedHosts",
    "main",
    "EMBED_HOSTS",
    "text",
    "/admin/settings/embed-hosts",
    "settings-embed-hosts",
    "embed_hosts",
    "Embed host restrictions",
    "embedHosts",
  ],
  [
    "customCss",
    "advanced",
    "CUSTOM_CSS",
    "textarea",
    "/admin/settings/custom-css",
    "settings-custom-css",
    "custom_css",
    "Custom CSS",
    "customCss",
  ],
  [
    "showPublicApi",
    "advanced",
    "SHOW_PUBLIC_API",
    "boolean",
    "/admin/settings/show-public-api",
    "settings-show-public-api",
    "show_public_api",
    "Public API",
    "showPublicApi",
  ],
  [
    "externalOrder",
    "advanced",
    "EXTERNAL_ORDER_ENABLED",
    "boolean",
    "/admin/settings/external-order",
    "settings-external-order",
    "external_order_enabled",
    "External order buttons",
    "externalOrderEnabled",
  ],
] satisfies readonly ExpectedFormRow[];

const expectedRow = ([
  name,
  page,
  keyName,
  kind,
  action,
  formId,
  fieldName,
  routeLabel,
  stateField,
]: ExpectedFormRow) => ({
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

const definitionRow = (
  definition: (typeof SETTINGS_FORM_DEFINITIONS)[number],
) => ({
  action: definition.action,
  fieldName: definition.fieldName,
  formId: definition.formId,
  key: definition.key,
  kind: definition.kind,
  name: definition.name,
  page: definition.page,
  routeLabel: definition.routeLabel,
  stateField: definition.stateField,
});

const values = (field: keyof ReturnType<typeof definitionRow>): string[] =>
  SETTINGS_FORM_DEFINITIONS.map((definition) => String(definition[field]));

const copyKeysFor = (
  definition: (typeof SETTINGS_FORM_DEFINITIONS)[number],
): (string | null)[] => [
  definition.copy.descriptionKey,
  "footerKey" in definition.copy ? definition.copy.footerKey : null,
  "labelKey" in definition.copy ? definition.copy.labelKey : null,
  "placeholderKey" in definition.copy ? definition.copy.placeholderKey : null,
  "submitLabelKey" in definition.copy ? definition.copy.submitLabelKey : null,
  definition.copy.titleKey,
];

const copyKeys = (): string[] =>
  SETTINGS_FORM_DEFINITIONS.flatMap((definition) =>
    copyKeysFor(definition).filter((key): key is string => key !== null),
  );

describe("settings form schema", () => {
  test("declares the generated settings forms", () => {
    expect(SETTINGS_FORM_DEFINITIONS.map(definitionRow)).toEqual(
      EXPECTED_FORM_ROWS.map(expectedRow),
    );
  });

  test("indexes forms by name", () => {
    expect(Object.keys(SETTINGS_FORMS)).toEqual(
      EXPECTED_FORM_ROWS.map((row) => row[0]),
    );
  });

  test("uses unique names, actions, form ids, and field names", () => {
    for (const field of ["name", "action", "formId", "fieldName"] as const) {
      const all = values(field);
      expect(new Set(all).size).toBe(all.length);
    }
  });

  test("points every copy key at an existing locale string", () => {
    const messages = en as Record<string, string>;
    expect(copyKeys().filter((key) => !(key in messages))).toEqual([]);
  });
});
