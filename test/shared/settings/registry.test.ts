import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CONFIG_KEY_NAMES } from "#shared/settings/keys.ts";
import {
  CONFIG_KEYS,
  EMAIL_BODY_KEYS,
  ENCRYPTED_KEYS,
  PLAINTEXT_KEYS,
  STRING_ACCESSORS,
  STRING_SETTING_DEFINITIONS,
} from "#shared/settings/registry.ts";

type ExpectedSettingFlag = "emailBody" | "readOnly";
type ExpectedSettingRow = readonly [
  keyof typeof CONFIG_KEYS,
  "plaintext" | "encrypted",
  string | null,
  ...ExpectedSettingFlag[],
];

const lines = (text: string): string[] =>
  text
    .trim()
    .split("\n")
    .map((line) => line.trim());

const EXPECTED_CONFIG_KEY_NAMES = lines(`
  ADDRESS_LOOKUP_API_KEY
  ADDRESS_LOOKUP_PROVIDER
  APPLE_WALLET_PASS_TYPE_ID
  APPLE_WALLET_SIGNING_CERT
  APPLE_WALLET_SIGNING_KEY
  APPLE_WALLET_TEAM_ID
  APPLE_WALLET_WWDR_CERT
  ATTENDEE_COLUMN_ORDER
  AUTO_PURGE_ORPHANS
  BOOKING_FEE
  BULK_EMAIL_DRAFT
  BUNNY_SUBDOMAIN
  BUSINESS_EMAIL
  CALENDAR_FEEDS_ENABLED
  CALENDAR_FEEDS_GROUP_BY
  CONTACT_FORM_ENABLED
  CONTACT_PAGE_TEXT
  COUNTRY
  CURRENT_TASK
  CUSTOM_CSS
  CUSTOM_DOMAIN
  CUSTOM_DOMAIN_LAST_VALIDATED
  EMAIL_API_KEY
  EMAIL_FROM_ADDRESS
  EMAIL_PROVIDER
  EMAIL_TPL_ADMIN_HTML
  EMAIL_TPL_ADMIN_SUBJECT
  EMAIL_TPL_ADMIN_TEXT
  EMAIL_TPL_CONFIRMATION_HTML
  EMAIL_TPL_CONFIRMATION_SUBJECT
  EMAIL_TPL_CONFIRMATION_TEXT
  EMBED_HOSTS
  ENABLED_FEATURES
  EXTERNAL_ORDER_ENABLED
  GOOGLE_WALLET_ISSUER_ID
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL
  GOOGLE_WALLET_SERVICE_ACCOUNT_KEY
  HEADER_IMAGE_URL
  HOMEPAGE_TEXT
  LAST_ACTIVE_PAYMENT_PROVIDER
  LATEST_SCRIPT_VERSION
  LATEST_SCRIPT_VERSION_NAME
  LISTING_COLUMN_ORDER
  LISTING_DEFAULTS
  ORDER_ENABLED
  ORDER_INTRO_TEXT
  ORPHAN_PURGE_RETENTION
  PAYMENT_PROVIDER
  PUBLIC_KEY
  SETTINGS_VERSION
  SETUP_COMPLETE
  SHOW_PUBLIC_API
  SMS_GATEWAY_BASE_URL
  SMS_GATEWAY_PASSPHRASE
  SMS_GATEWAY_PASSWORD
  SMS_GATEWAY_USERNAME
  SMS_GATEWAY_WEBHOOK_SECRET
  SQUARE_ACCESS_TOKEN
  SQUARE_LOCATION_ID
  SQUARE_SANDBOX
  SQUARE_WEBHOOK_SIGNATURE_KEY
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_ENDPOINT_ID
  STRIPE_WEBHOOK_SECRET
  SUMUP_API_KEY
  SUMUP_MERCHANT_CODE
  SUPERUSER_CHOICE
  SUPPORT_FORM_LAST_SUBMITTED
  TERMS_AND_CONDITIONS
  THEME
  UNDERLINE_LINKS
  WEBSITE_TITLE
  WRAPPED_PRIVATE_KEY
`);

const EXPECTED_SETTING_ROWS = [
  ["TERMS_AND_CONDITIONS", "plaintext", "terms"],
  ["BULK_EMAIL_DRAFT", "plaintext", "bulkEmailDraft"],
  ["EMAIL_PROVIDER", "plaintext", null],
  ["ADDRESS_LOOKUP_PROVIDER", "plaintext", null],
  ["ADDRESS_LOOKUP_API_KEY", "encrypted", null],
  ["ENABLED_FEATURES", "plaintext", null],
  ["CUSTOM_CSS", "plaintext", "customCss"],
  ["CUSTOM_DOMAIN", "plaintext", "customDomain"],
  [
    "CUSTOM_DOMAIN_LAST_VALIDATED",
    "plaintext",
    "customDomainLastValidated",
    "readOnly",
  ],
  ["BUNNY_SUBDOMAIN", "plaintext", "bunnySubdomain"],
  ["CURRENT_TASK", "plaintext", "currentTask"],
  ["PUBLIC_KEY", "plaintext", "publicKey", "readOnly"],
  ["WRAPPED_PRIVATE_KEY", "plaintext", "wrappedPrivateKey", "readOnly"],
  ["SQUARE_LOCATION_ID", "plaintext", null],
  ["STRIPE_WEBHOOK_ENDPOINT_ID", "plaintext", null],
  ["SUMUP_MERCHANT_CODE", "plaintext", null],
  ["LATEST_SCRIPT_VERSION", "plaintext", "latestScriptVersion"],
  ["LATEST_SCRIPT_VERSION_NAME", "plaintext", "latestScriptVersionName"],
  ["LAST_ACTIVE_PAYMENT_PROVIDER", "plaintext", null],
  ["SUPERUSER_CHOICE", "plaintext", null],
  [
    "SUPPORT_FORM_LAST_SUBMITTED",
    "plaintext",
    "supportFormLastSubmitted",
    "readOnly",
  ],
  ["LISTING_COLUMN_ORDER", "plaintext", "listingColumnOrder"],
  ["ATTENDEE_COLUMN_ORDER", "plaintext", "attendeeColumnOrder"],
  ["SMS_GATEWAY_BASE_URL", "plaintext", "smsGatewayBaseUrl"],
  ["BUSINESS_EMAIL", "encrypted", "businessEmail"],
  ["HEADER_IMAGE_URL", "encrypted", "headerImageUrl"],
  ["WEBSITE_TITLE", "encrypted", "websiteTitle"],
  ["HOMEPAGE_TEXT", "encrypted", "homepageText"],
  ["CONTACT_PAGE_TEXT", "encrypted", "contactPageText"],
  ["ORDER_INTRO_TEXT", "encrypted", "orderIntroText"],
  ["STRIPE_SECRET_KEY", "encrypted", null],
  ["STRIPE_WEBHOOK_SECRET", "encrypted", null],
  ["SQUARE_ACCESS_TOKEN", "encrypted", null],
  ["SQUARE_WEBHOOK_SIGNATURE_KEY", "encrypted", null],
  ["SUMUP_API_KEY", "encrypted", null],
  ["EMBED_HOSTS", "encrypted", "embedHosts"],
  ["EMAIL_API_KEY", "encrypted", null, "emailBody"],
  ["EMAIL_FROM_ADDRESS", "encrypted", null, "emailBody"],
  ["EMAIL_TPL_CONFIRMATION_SUBJECT", "encrypted", null, "emailBody"],
  ["EMAIL_TPL_CONFIRMATION_HTML", "encrypted", null, "emailBody"],
  ["EMAIL_TPL_CONFIRMATION_TEXT", "encrypted", null, "emailBody"],
  ["EMAIL_TPL_ADMIN_SUBJECT", "encrypted", null, "emailBody"],
  ["EMAIL_TPL_ADMIN_HTML", "encrypted", null, "emailBody"],
  ["EMAIL_TPL_ADMIN_TEXT", "encrypted", null, "emailBody"],
  ["APPLE_WALLET_PASS_TYPE_ID", "encrypted", null],
  ["APPLE_WALLET_TEAM_ID", "encrypted", null],
  ["APPLE_WALLET_SIGNING_CERT", "encrypted", null],
  ["APPLE_WALLET_SIGNING_KEY", "encrypted", null],
  ["APPLE_WALLET_WWDR_CERT", "encrypted", null],
  ["GOOGLE_WALLET_ISSUER_ID", "encrypted", null],
  ["GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL", "encrypted", null],
  ["GOOGLE_WALLET_SERVICE_ACCOUNT_KEY", "encrypted", null],
  ["SMS_GATEWAY_PASSPHRASE", "encrypted", "smsGatewayPassphrase"],
  ["SMS_GATEWAY_USERNAME", "encrypted", "smsGatewayUsername"],
  ["SMS_GATEWAY_PASSWORD", "encrypted", "smsGatewayPassword"],
  ["SMS_GATEWAY_WEBHOOK_SECRET", "encrypted", "smsGatewayWebhookSecret"],
  ["LISTING_DEFAULTS", "encrypted", null],
] satisfies readonly ExpectedSettingRow[];

const sorted = (values: readonly string[]): string[] => [...values].sort();

const taggedKeys = (tag: "emailBody"): string[] =>
  STRING_SETTING_DEFINITIONS.filter(
    (definition) =>
      "tags" in definition &&
      (definition.tags as readonly string[]).includes(tag),
  ).map((definition) => definition.key);

const accessorKeys = (): string[] =>
  STRING_SETTING_DEFINITIONS.filter(
    (definition) => "accessor" in definition,
  ).map((definition) => definition.key);

const settingTags = (flags: readonly ExpectedSettingFlag[]) =>
  flags.filter((flag): flag is "emailBody" => flag !== "readOnly");

const settingRow = ([
  keyName,
  storage,
  accessorName,
  ...flags
]: ExpectedSettingRow) => ({
  accessor:
    accessorName === null
      ? null
      : {
          name: accessorName,
          readOnly: flags.includes("readOnly"),
        },
  key: CONFIG_KEYS[keyName],
  storage,
  tags: settingTags(flags),
});

const definitionRow = (
  definition: (typeof STRING_SETTING_DEFINITIONS)[number],
) => ({
  accessor:
    "accessor" in definition
      ? {
          name: definition.accessor.name,
          readOnly:
            "readOnly" in definition.accessor && definition.accessor.readOnly,
        }
      : null,
  key: definition.key,
  storage: definition.storage,
  tags: "tags" in definition ? [...definition.tags] : [],
});

const expectedAccessors = () =>
  Object.fromEntries(
    EXPECTED_SETTING_ROWS.filter((row) => row[2] !== null).map((row) => {
      const { accessor, key } = settingRow(row);
      return [
        accessor!.name,
        accessor!.readOnly ? { key, readOnly: true } : { key },
      ];
    }),
  );

describe("settings registry", () => {
  test("declares exactly the expected config key names", () => {
    expect(CONFIG_KEY_NAMES).toEqual(EXPECTED_CONFIG_KEY_NAMES);
  });

  test("derives stored config keys from their exported names", () => {
    for (const name of CONFIG_KEY_NAMES) {
      expect(CONFIG_KEYS[name]).toBe(name.toLowerCase());
    }
  });

  test("declares exactly the string-backed settings", () => {
    expect(STRING_SETTING_DEFINITIONS.map(definitionRow)).toEqual(
      EXPECTED_SETTING_ROWS.map(settingRow),
    );
  });

  test("stores each string setting key once", () => {
    const keys = STRING_SETTING_DEFINITIONS.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("uses plaintext and encrypted buckets as a full partition", () => {
    const allKeys = STRING_SETTING_DEFINITIONS.map(
      (definition) => definition.key,
    );
    const storageKeys = [...PLAINTEXT_KEYS, ...ENCRYPTED_KEYS];
    const encrypted = new Set(ENCRYPTED_KEYS);

    expect(sorted(storageKeys)).toEqual(sorted(allKeys));
    expect(PLAINTEXT_KEYS.filter((key) => encrypted.has(key))).toEqual([]);
  });

  test("derives tagged bundles from the same setting entries", () => {
    expect(EMAIL_BODY_KEYS).toEqual(taggedKeys("emailBody"));
  });

  test("derives generated accessors from setting entries", () => {
    const generatedKeys = Object.values(STRING_ACCESSORS).map(
      (spec) => spec.key,
    );

    expect(sorted(generatedKeys)).toEqual(sorted(accessorKeys()));
    expect(STRING_ACCESSORS).toEqual(expectedAccessors());
  });
});
