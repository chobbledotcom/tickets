import { CONFIG_KEYS, type ConfigKey } from "#shared/settings/keys.ts";

export type { ConfigKey };
export { CONFIG_KEYS };

type StringStorage = "plaintext" | "encrypted";
type StringTag = "emailBody" | "prune";

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

const setting = <const Definition extends StringSettingConfig>(
  definition: Definition,
): Definition => definition;

/** A "last pruned" timestamp setting: plaintext, tagged for the pruner, and
 * reached by an accessor of the given name. Collapses the repeated shape of the
 * housekeeping timestamps below into one call. */
const pruneSetting = <const Name extends string, const Key extends ConfigKey>(
  name: Name,
  key: Key,
) =>
  setting({
    accessor: { name },
    key,
    storage: "plaintext",
    tags: ["prune"],
  });

/** An email template/credential setting: encrypted and tagged so it is rebuilt
 * whenever the email body changes. Collapses the repeated shape of the email
 * settings below into one call. */
const emailBodySetting = <const Key extends ConfigKey>(key: Key) =>
  setting({
    key,
    storage: "encrypted",
    tags: ["emailBody"],
  });

export const STRING_SETTING_DEFINITIONS = [
  setting({
    accessor: { name: "terms" },
    key: CONFIG_KEYS.TERMS_AND_CONDITIONS,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "bulkEmailDraft" },
    key: CONFIG_KEYS.BULK_EMAIL_DRAFT,
    storage: "plaintext",
  }),
  setting({ key: CONFIG_KEYS.EMAIL_PROVIDER, storage: "plaintext" }),
  setting({ key: CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER, storage: "plaintext" }),
  setting({ key: CONFIG_KEYS.ADDRESS_LOOKUP_API_KEY, storage: "encrypted" }),
  // Custom CSS is served verbatim as a public stylesheet at /custom.css, so it
  // is stored unencrypted. There is nothing secret about it.
  setting({
    accessor: { name: "customCss" },
    key: CONFIG_KEYS.CUSTOM_CSS,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "customDomain" },
    key: CONFIG_KEYS.CUSTOM_DOMAIN,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "customDomainLastValidated", readOnly: true },
    key: CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "bunnySubdomain" },
    key: CONFIG_KEYS.BUNNY_SUBDOMAIN,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "currentTask" },
    key: CONFIG_KEYS.CURRENT_TASK,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "publicKey", readOnly: true },
    key: CONFIG_KEYS.PUBLIC_KEY,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "wrappedPrivateKey", readOnly: true },
    key: CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
    storage: "plaintext",
  }),
  setting({ key: CONFIG_KEYS.SQUARE_LOCATION_ID, storage: "plaintext" }),
  setting({
    key: CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
    storage: "plaintext",
  }),
  setting({ key: CONFIG_KEYS.SUMUP_MERCHANT_CODE, storage: "plaintext" }),
  setting({
    accessor: { name: "latestScriptVersion" },
    key: CONFIG_KEYS.LATEST_SCRIPT_VERSION,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "latestScriptVersionName" },
    key: CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME,
    storage: "plaintext",
  }),
  setting({ key: CONFIG_KEYS.SUPERUSER_CHOICE, storage: "plaintext" }),
  setting({
    accessor: { name: "supportFormLastSubmitted", readOnly: true },
    key: CONFIG_KEYS.SUPPORT_FORM_LAST_SUBMITTED,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "listingColumnOrder" },
    key: CONFIG_KEYS.LISTING_COLUMN_ORDER,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "attendeeColumnOrder" },
    key: CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "lastPrunedPayments" },
    key: CONFIG_KEYS.LAST_PRUNED_PAYMENTS,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "lastPrunedSessions" },
    key: CONFIG_KEYS.LAST_PRUNED_SESSIONS,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "lastPrunedSumup" },
    key: CONFIG_KEYS.LAST_PRUNED_SUMUP,
    storage: "plaintext",
  }),
  pruneSetting("lastPrunedStrings", CONFIG_KEYS.LAST_PRUNED_STRINGS),
  pruneSetting("lastPrunedLogins", CONFIG_KEYS.LAST_PRUNED_LOGINS),
  pruneSetting("lastPrunedTokens", CONFIG_KEYS.LAST_PRUNED_TOKENS),
  pruneSetting("lastPrunedContacts", CONFIG_KEYS.LAST_PRUNED_CONTACTS),
  pruneSetting("lastPrunedAddresses", CONFIG_KEYS.LAST_PRUNED_ADDRESSES),
  pruneSetting("lastPrunedInvites", CONFIG_KEYS.LAST_PRUNED_INVITES),
  pruneSetting("lastPrunedOrphans", CONFIG_KEYS.LAST_PRUNED_ORPHANS),
  setting({
    accessor: { name: "smsGatewayBaseUrl" },
    key: CONFIG_KEYS.SMS_GATEWAY_BASE_URL,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "activityLogBackfillDone" },
    key: CONFIG_KEYS.ACTIVITY_LOG_BACKFILL_DONE,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "lastActivityLogBackfill" },
    key: CONFIG_KEYS.LAST_ACTIVITY_LOG_BACKFILL,
    storage: "plaintext",
  }),
  setting({
    accessor: { name: "businessEmail" },
    key: CONFIG_KEYS.BUSINESS_EMAIL,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "headerImageUrl" },
    key: CONFIG_KEYS.HEADER_IMAGE_URL,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "websiteTitle" },
    key: CONFIG_KEYS.WEBSITE_TITLE,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "homepageText" },
    key: CONFIG_KEYS.HOMEPAGE_TEXT,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "contactPageText" },
    key: CONFIG_KEYS.CONTACT_PAGE_TEXT,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "orderIntroText" },
    key: CONFIG_KEYS.ORDER_INTRO_TEXT,
    storage: "encrypted",
  }),
  setting({ key: CONFIG_KEYS.STRIPE_SECRET_KEY, storage: "encrypted" }),
  setting({ key: CONFIG_KEYS.STRIPE_WEBHOOK_SECRET, storage: "encrypted" }),
  setting({ key: CONFIG_KEYS.SQUARE_ACCESS_TOKEN, storage: "encrypted" }),
  setting({
    key: CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
    storage: "encrypted",
  }),
  setting({ key: CONFIG_KEYS.SUMUP_API_KEY, storage: "encrypted" }),
  setting({
    accessor: { name: "embedHosts" },
    key: CONFIG_KEYS.EMBED_HOSTS,
    storage: "encrypted",
  }),
  emailBodySetting(CONFIG_KEYS.EMAIL_API_KEY),
  emailBodySetting(CONFIG_KEYS.EMAIL_FROM_ADDRESS),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_ADMIN_SUBJECT),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_ADMIN_HTML),
  emailBodySetting(CONFIG_KEYS.EMAIL_TPL_ADMIN_TEXT),
  setting({
    key: CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID,
    storage: "encrypted",
  }),
  setting({ key: CONFIG_KEYS.APPLE_WALLET_TEAM_ID, storage: "encrypted" }),
  setting({
    key: CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT,
    storage: "encrypted",
  }),
  setting({
    key: CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    storage: "encrypted",
  }),
  setting({ key: CONFIG_KEYS.APPLE_WALLET_WWDR_CERT, storage: "encrypted" }),
  setting({ key: CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID, storage: "encrypted" }),
  setting({
    key: CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
    storage: "encrypted",
  }),
  setting({
    key: CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "smsGatewayPassphrase" },
    key: CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "smsGatewayUsername" },
    key: CONFIG_KEYS.SMS_GATEWAY_USERNAME,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "smsGatewayPassword" },
    key: CONFIG_KEYS.SMS_GATEWAY_PASSWORD,
    storage: "encrypted",
  }),
  setting({
    accessor: { name: "smsGatewayWebhookSecret" },
    key: CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
    storage: "encrypted",
  }),
  // The defaults blob can carry a webhook / thank-you URL, which commonly hold
  // bearer tokens or private endpoints. The same fields are encrypted on
  // listings, so the shared default is encrypted at rest too.
  setting({ key: CONFIG_KEYS.LISTING_DEFAULTS, storage: "encrypted" }),
] as const;

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
export const PRUNE_KEYS = keysWithTag("prune");
export const EMAIL_BODY_KEYS = keysWithTag("emailBody");
