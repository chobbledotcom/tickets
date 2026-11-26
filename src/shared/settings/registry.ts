import { definition } from "#shared/settings/definition.ts";
import { CONFIG_KEYS, type ConfigKey } from "#shared/settings/keys.ts";

export type { ConfigKey };
export { CONFIG_KEYS };

type StringStorage = "plaintext" | "encrypted";
type StringTag = "emailBody";

type AccessorConfig = {
  name: string;
  readOnly?: true;
};

type StringSettingConfig<K extends ConfigKey = ConfigKey> = {
  key: K;
  storage: StringStorage;
  tags?: readonly StringTag[];
  accessor?: AccessorConfig;
};

/** An email template/credential setting: encrypted and tagged so it is rebuilt
 * whenever the email body changes. Collapses the repeated shape of the email
 * settings below into one call. */
const emailBodySetting = <const Key extends ConfigKey>(key: Key) =>
  definition({
    key,
    storage: "encrypted",
    tags: ["emailBody"],
  });

/** A setting that the settings object reads and writes by a name. */
const accessorSetting = <
  const Storage extends StringStorage,
  const Name extends string,
  const Key extends ConfigKey,
>(
  storage: Storage,
  name: Name,
  key: Key,
) => definition({ accessor: { name }, key, storage });

/** A plaintext setting that the settings object reads by a name and never
 * writes. Another module stores it. */
const readOnlySetting = <
  const Name extends string,
  const Key extends ConfigKey,
>(
  name: Name,
  key: Key,
) =>
  definition({
    accessor: { name, readOnly: true as const },
    key,
    storage: "plaintext" as const,
  });

export const STRING_SETTING_DEFINITIONS = [
  accessorSetting("plaintext", "terms", CONFIG_KEYS.TERMS_AND_CONDITIONS),
  accessorSetting("plaintext", "reviewsMarkdown", CONFIG_KEYS.REVIEWS_MARKDOWN),
  accessorSetting("plaintext", "bulkEmailDraft", CONFIG_KEYS.BULK_EMAIL_DRAFT),
  definition({ key: CONFIG_KEYS.EMAIL_PROVIDER, storage: "plaintext" }),
  definition({
    key: CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
    storage: "plaintext",
  }),
  definition({ key: CONFIG_KEYS.ADDRESS_LOOKUP_API_KEY, storage: "encrypted" }),
  definition({ key: CONFIG_KEYS.ENABLED_FEATURES, storage: "plaintext" }),
  definition({ key: CONFIG_KEYS.TAX, storage: "plaintext" }),
  // Custom CSS is served verbatim as a public stylesheet at /custom.css, so it
  // is stored unencrypted. There is nothing secret about it.
  accessorSetting("plaintext", "customCss", CONFIG_KEYS.CUSTOM_CSS),
  accessorSetting("plaintext", "customDomain", CONFIG_KEYS.CUSTOM_DOMAIN),
  readOnlySetting(
    "customDomainLastValidated",
    CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  ),
  accessorSetting("plaintext", "bunnySubdomain", CONFIG_KEYS.BUNNY_SUBDOMAIN),
  accessorSetting("plaintext", "currentTask", CONFIG_KEYS.CURRENT_TASK),
  readOnlySetting("publicKey", CONFIG_KEYS.PUBLIC_KEY),
  // How many redirects the redirects table holds. Every redirect write sets it
  // in the same batch as the row. The advanced settings page and the
  // missing-page check read it from the settings that load for every request.
  // They do not query the table.
  readOnlySetting("redirectCount", CONFIG_KEYS.REDIRECT_COUNT),
  readOnlySetting("wrappedPrivateKey", CONFIG_KEYS.WRAPPED_PRIVATE_KEY),
  definition({ key: CONFIG_KEYS.SQUARE_LOCATION_ID, storage: "plaintext" }),
  definition({
    key: CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
    storage: "plaintext",
  }),
  definition({ key: CONFIG_KEYS.SUMUP_MERCHANT_CODE, storage: "plaintext" }),
  accessorSetting(
    "plaintext",
    "latestScriptVersion",
    CONFIG_KEYS.LATEST_SCRIPT_VERSION,
  ),
  accessorSetting(
    "plaintext",
    "latestScriptVersionName",
    CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME,
  ),
  // The provider that was active before the operator switched new sales off
  // ("none"). Its credentials stay stored. Refunds, replayed callbacks, and
  // in-flight completions of payments that already exist keep running against
  // the provider that captured them. The money does not get stranded.
  definition({
    key: CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
    storage: "plaintext",
  }),
  definition({ key: CONFIG_KEYS.SUPERUSER_CHOICE, storage: "plaintext" }),
  readOnlySetting(
    "supportFormLastSubmitted",
    CONFIG_KEYS.SUPPORT_FORM_LAST_SUBMITTED,
  ),
  accessorSetting(
    "plaintext",
    "listingColumnOrder",
    CONFIG_KEYS.LISTING_COLUMN_ORDER,
  ),
  accessorSetting(
    "plaintext",
    "attendeeColumnOrder",
    CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
  ),
  // The run sheet's two Liquid templates. The text is the owner's own markup
  // for a signed-in admin page, so it is stored unencrypted.
  accessorSetting(
    "plaintext",
    "logisticsRunSheetBody",
    CONFIG_KEYS.LOGISTICS_RUN_SHEET_BODY,
  ),
  accessorSetting(
    "plaintext",
    "logisticsRunSheetHeading",
    CONFIG_KEYS.LOGISTICS_RUN_SHEET_HEADING,
  ),
  // The invoice text the operator kept on the last invoice they made. It holds
  // no customer facts, so it is stored unencrypted.
  accessorSetting(
    "plaintext",
    "invoiceBodyTemplate",
    CONFIG_KEYS.INVOICE_BODY_TEMPLATE,
  ),
  accessorSetting(
    "plaintext",
    "smsGatewayBaseUrl",
    CONFIG_KEYS.SMS_GATEWAY_BASE_URL,
  ),
  accessorSetting("encrypted", "businessEmail", CONFIG_KEYS.BUSINESS_EMAIL),
  accessorSetting("encrypted", "headerImageUrl", CONFIG_KEYS.HEADER_IMAGE_URL),
  accessorSetting("encrypted", "websiteTitle", CONFIG_KEYS.WEBSITE_TITLE),
  accessorSetting("encrypted", "homepageText", CONFIG_KEYS.HOMEPAGE_TEXT),
  accessorSetting(
    "encrypted",
    "contactPageText",
    CONFIG_KEYS.CONTACT_PAGE_TEXT,
  ),
  accessorSetting("encrypted", "orderIntroText", CONFIG_KEYS.ORDER_INTRO_TEXT),
  accessorSetting("encrypted", "siteFooter", CONFIG_KEYS.SITE_FOOTER),
  definition({ key: CONFIG_KEYS.STRIPE_SECRET_KEY, storage: "encrypted" }),
  definition({ key: CONFIG_KEYS.STRIPE_WEBHOOK_SECRET, storage: "encrypted" }),
  definition({ key: CONFIG_KEYS.SQUARE_ACCESS_TOKEN, storage: "encrypted" }),
  definition({
    key: CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
    storage: "encrypted",
  }),
  definition({ key: CONFIG_KEYS.SUMUP_API_KEY, storage: "encrypted" }),
  accessorSetting("encrypted", "embedHosts", CONFIG_KEYS.EMBED_HOSTS),
  emailBodySetting(CONFIG_KEYS.EMAIL_API_KEY),
  emailBodySetting(CONFIG_KEYS.EMAIL_FROM_ADDRESS),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_ADMIN_SUBJECT),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_ADMIN_HTML),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_ADMIN_TEXT),
  definition({
    key: CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID,
    storage: "encrypted",
  }),
  definition({ key: CONFIG_KEYS.APPLE_WALLET_TEAM_ID, storage: "encrypted" }),
  definition({
    key: CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT,
    storage: "encrypted",
  }),
  definition({
    key: CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    storage: "encrypted",
  }),
  definition({ key: CONFIG_KEYS.APPLE_WALLET_WWDR_CERT, storage: "encrypted" }),
  definition({
    key: CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID,
    storage: "encrypted",
  }),
  definition({
    key: CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
    storage: "encrypted",
  }),
  definition({
    key: CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
    storage: "encrypted",
  }),
  accessorSetting(
    "encrypted",
    "smsGatewayPassphrase",
    CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
  ),
  accessorSetting(
    "encrypted",
    "smsGatewayUsername",
    CONFIG_KEYS.SMS_GATEWAY_USERNAME,
  ),
  accessorSetting(
    "encrypted",
    "smsGatewayPassword",
    CONFIG_KEYS.SMS_GATEWAY_PASSWORD,
  ),
  accessorSetting(
    "encrypted",
    "smsGatewayWebhookSecret",
    CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
  ),
  // The defaults blob can carry a webhook / thank-you URL, which commonly hold
  // bearer tokens or private endpoints. The same fields are encrypted on
  // listings, so the shared default is encrypted at rest too.
  definition({ key: CONFIG_KEYS.LISTING_DEFAULTS, storage: "encrypted" }),
] as const satisfies readonly StringSettingConfig[];

export type StringSettingDefinition =
  (typeof STRING_SETTING_DEFINITIONS)[number];
export type StringSettingKey = StringSettingDefinition["key"];

type SettingWithAccessor = Extract<
  StringSettingDefinition,
  { accessor: AccessorConfig }
>;

export type StringAccessorName = SettingWithAccessor["accessor"]["name"];

type SettingForAccessor<Name extends StringAccessorName> = Extract<
  SettingWithAccessor,
  { accessor: { name: Name } }
>;

type AccessorSpecFor<Name extends StringAccessorName> =
  SettingForAccessor<Name> extends {
    accessor: { readOnly: true };
    key: infer Key extends StringSettingKey;
  }
    ? { key: Key; readOnly: true }
    : SettingForAccessor<Name> extends {
          key: infer Key extends StringSettingKey;
        }
      ? { key: Key }
      : never;

export type AccessorSpec = {
  [Name in StringAccessorName]: AccessorSpecFor<Name>;
}[StringAccessorName];

export type StringAccessors = {
  readonly [Name in StringAccessorName]: AccessorSpecFor<Name>;
};

const hasAccessor = (
  definition: StringSettingDefinition,
): definition is SettingWithAccessor => "accessor" in definition;

const accessorSpec = (definition: SettingWithAccessor): AccessorSpec => {
  if ("readOnly" in definition.accessor && definition.accessor.readOnly) {
    return { key: definition.key, readOnly: true } as AccessorSpec;
  }
  return { key: definition.key } as AccessorSpec;
};

export const STRING_ACCESSORS = Object.fromEntries(
  STRING_SETTING_DEFINITIONS.filter(hasAccessor).map((definition) => [
    definition.accessor.name,
    accessorSpec(definition),
  ]),
) as StringAccessors;

const keysWithStorage = (storage: StringStorage): readonly StringSettingKey[] =>
  STRING_SETTING_DEFINITIONS.filter(
    (definition) => definition.storage === storage,
  ).map((definition) => definition.key);

const keysWithTag = (tag: StringTag): readonly StringSettingKey[] =>
  STRING_SETTING_DEFINITIONS.filter(
    (definition) =>
      "tags" in definition &&
      (definition.tags as readonly StringTag[]).includes(tag),
  ).map((definition) => definition.key);

export const PLAINTEXT_KEYS = keysWithStorage("plaintext");
export const ENCRYPTED_KEYS = keysWithStorage("encrypted");
export const EMAIL_BODY_KEYS = keysWithTag("emailBody");
