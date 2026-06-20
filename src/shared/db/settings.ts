/**
 * Settings — sync reads, async writes.
 *
 * Call `settings.loadKeys(keys)` before a request to populate the snapshot.
 * After that, every setting is a plain sync property:
 *
 *   settings.theme            // "light"
 *   settings.headerImageUrl   // string
 *   settings.stripe.secretKey // string
 *
 * Writes go through `settings.update.*`:
 *
 *   await settings.update.theme("dark");
 *   await settings.update.headerImageUrl(url);
 */

import { lazyRef, unique } from "#fp";
import {
  registerCache,
  registerTableInvalidation,
} from "#shared/cache-registry.ts";
import { DEFAULT_COUNTRY, getCountry } from "#shared/countries.ts";
import { decrypt, encrypt, encryptWithKey } from "#shared/crypto/encryption.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import {
  deriveKEK,
  generateDataKey,
  generateKeyPair,
  unwrapKey,
  wrapKey,
} from "#shared/crypto/keys.ts";
import {
  execute,
  executeWithoutCacheInvalidation,
  queryAll,
} from "#shared/db/client.ts";
import { deleteAllSessions } from "#shared/db/sessions.ts";
import {
  recordSettingRead,
  recordSettingsLoaded,
} from "#shared/db/settings-audit.ts";
import { createUser, invalidateUsersCache } from "#shared/db/users.ts";
import { nowMs } from "#shared/now.ts";
import {
  DEFAULT_ORPHAN_RETENTION,
  isOrphanRetentionValue,
} from "#shared/orphan-retention.ts";
import { DEFAULT_TIMEZONE } from "#shared/timezone.ts";
import type {
  PaymentProviderSetting,
  PaymentProviderType,
  Settings,
  SuperuserChoice,
  Theme,
} from "#shared/types.ts";
import {
  isPaymentProvider,
  isPaymentProviderSetting,
  isSuperuserChoice,
} from "#shared/types.ts";
import {
  createAppleWalletReadSettings,
  createAppleWalletUpdateSettings,
} from "#shared/wallets/apple-wallet-settings.ts";
import {
  createGoogleWalletReadSettings,
  createGoogleWalletUpdateSettings,
} from "#shared/wallets/google-wallet-settings.ts";
import type { EncryptedUpdateFn } from "#shared/wallets/wallet-settings-types.ts";

// ---------------------------------------------------------------------------
// Setting keys
// ---------------------------------------------------------------------------

export const CONFIG_KEYS = {
  APPLE_WALLET_PASS_TYPE_ID: "apple_wallet_pass_type_id",
  APPLE_WALLET_SIGNING_CERT: "apple_wallet_signing_cert",
  APPLE_WALLET_SIGNING_KEY: "apple_wallet_signing_key",
  APPLE_WALLET_TEAM_ID: "apple_wallet_team_id",
  APPLE_WALLET_WWDR_CERT: "apple_wallet_wwdr_cert",
  ATTENDEE_COLUMN_ORDER: "attendee_column_order",
  AUTO_PURGE_ORPHANS: "auto_purge_orphans",
  BOOKING_FEE: "booking_fee",
  BULK_EMAIL_DRAFT: "bulk_email_draft",
  BUNNY_SUBDOMAIN: "bunny_subdomain",
  BUSINESS_EMAIL: "business_email",
  CALENDAR_FEEDS_ENABLED: "calendar_feeds_enabled",
  CALENDAR_FEEDS_GROUP_BY: "calendar_feeds_group_by",
  CONTACT_FORM_ENABLED: "contact_form_enabled",
  CONTACT_PAGE_TEXT: "contact_page_text",
  COUNTRY: "country",
  CURRENT_TASK: "current_task",
  CUSTOM_DOMAIN: "custom_domain",
  CUSTOM_DOMAIN_LAST_VALIDATED: "custom_domain_last_validated",
  EMAIL_API_KEY: "email_api_key",
  EMAIL_FROM_ADDRESS: "email_from_address",
  EMAIL_PROVIDER: "email_provider",
  EMAIL_TPL_ADMIN_HTML: "email_tpl_admin_html",
  EMAIL_TPL_ADMIN_SUBJECT: "email_tpl_admin_subject",
  EMAIL_TPL_ADMIN_TEXT: "email_tpl_admin_text",
  EMAIL_TPL_CONFIRMATION_HTML: "email_tpl_confirmation_html",
  EMAIL_TPL_CONFIRMATION_SUBJECT: "email_tpl_confirmation_subject",
  EMAIL_TPL_CONFIRMATION_TEXT: "email_tpl_confirmation_text",
  EMBED_HOSTS: "embed_hosts",
  GOOGLE_WALLET_ISSUER_ID: "google_wallet_issuer_id",
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "google_wallet_service_account_email",
  GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: "google_wallet_service_account_key",
  HAS_LOGISTICS: "has_logistics",
  HEADER_IMAGE_URL: "header_image_url",
  HOMEPAGE_TEXT: "homepage_text",
  LAST_PRUNED_CONTACTS: "last_pruned_contacts",
  LAST_PRUNED_LOGINS: "last_pruned_logins",
  LAST_PRUNED_ORPHANS: "last_pruned_orphans",
  LAST_PRUNED_PAYMENTS: "last_pruned_payments",
  LAST_PRUNED_SESSIONS: "last_pruned_sessions",
  LAST_PRUNED_STRINGS: "last_pruned_strings",
  LAST_PRUNED_SUMUP: "last_pruned_sumup",
  LAST_PRUNED_TOKENS: "last_pruned_tokens",
  LATEST_SCRIPT_VERSION: "latest_script_version",
  LATEST_SCRIPT_VERSION_NAME: "latest_script_version_name",
  LISTING_COLUMN_ORDER: "listing_column_order",
  ORDER_ENABLED: "order_enabled",
  ORDER_INTRO_TEXT: "order_intro_text",
  ORPHAN_PURGE_RETENTION: "orphan_purge_retention",
  PAYMENT_PROVIDER: "payment_provider",
  PUBLIC_KEY: "public_key",
  SETUP_COMPLETE: "setup_complete",
  SHOW_PUBLIC_API: "show_public_api",
  SHOW_PUBLIC_SITE: "show_public_site",
  SMS_GATEWAY_BASE_URL: "sms_gateway_base_url",
  SMS_GATEWAY_PASSPHRASE: "sms_gateway_passphrase",
  SMS_GATEWAY_PASSWORD: "sms_gateway_password",
  SMS_GATEWAY_USERNAME: "sms_gateway_username",
  SMS_GATEWAY_WEBHOOK_SECRET: "sms_gateway_webhook_secret",
  SQUARE_ACCESS_TOKEN: "square_access_token",
  SQUARE_LOCATION_ID: "square_location_id",
  SQUARE_SANDBOX: "square_sandbox",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "square_webhook_signature_key",
  STRIPE_SECRET_KEY: "stripe_secret_key",
  STRIPE_WEBHOOK_ENDPOINT_ID: "stripe_webhook_endpoint_id",
  STRIPE_WEBHOOK_SECRET: "stripe_webhook_secret",
  SUMUP_API_KEY: "sumup_api_key",
  SUMUP_MERCHANT_CODE: "sumup_merchant_code",
  SUPERUSER_CHOICE: "superuser_choice",
  SUPPORT_FORM_LAST_SUBMITTED: "support_form_last_submitted",
  TERMS_AND_CONDITIONS: "terms_and_conditions",
  THEME: "theme",
  WEBSITE_TITLE: "website_title",
  WRAPPED_PRIVATE_KEY: "wrapped_private_key",
} as const;

export const MASK_SENTINEL =
  "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
export const isMaskSentinel = (value: string): boolean =>
  value === MASK_SENTINEL;

/** Classify an API secret by its `sk_test_` / `sk_live_` prefix (Stripe + SumUp
 * share this convention). Empty or unrecognized keys yield null. */
const keyModeOf = (key: string): "test" | "live" | null =>
  key.startsWith("sk_test_")
    ? "test"
    : key.startsWith("sk_live_")
      ? "live"
      : null;

// ---------------------------------------------------------------------------
// Raw cache — stores DB rows in memory (60 s TTL)
// ---------------------------------------------------------------------------

export const SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * Raw-row cache. `values` holds the rows loaded so far (decrypted values still
 * live in the snapshot, not here). `loaded` records which keys have been
 * resolved — present *or* absent in the DB — so a partial `loadKeys` never
 * re-queries a key it has already fetched. `time` stamps the load for TTL
 * expiry; `0` means never loaded.
 */
type CacheState = {
  values: Map<string, string>;
  loaded: Set<string>;
  time: number;
};
const [getCacheState, setCacheState] = lazyRef<CacheState>(() => ({
  loaded: new Set(),
  time: 0,
  values: new Map(),
}));

const isCacheFresh = (): boolean => {
  const s = getCacheState();
  return s.time > 0 && nowMs() - s.time < SETTINGS_CACHE_TTL_MS;
};

/** Whether a key's value is already resolved in the current fresh cache. */
const isKeyLoaded = (key: string): boolean => {
  if (!isCacheFresh()) return false;
  return getCacheState().loaded.has(key);
};

registerCache(() => ({
  entries: getCacheState().values.size,
  name: "settings",
}));

// ---------------------------------------------------------------------------
// Snapshot — pre-resolved settings for sync access
// ---------------------------------------------------------------------------

/** Valid email template types */
export type EmailTemplateType = "confirmation" | "admin";

/** Valid email template formats */
export type EmailTemplateFormat = "subject" | "html" | "text";

/** Template type:format → config key */
type TemplateKeyMap = `${EmailTemplateType}:${EmailTemplateFormat}`;
const TEMPLATE_KEYS: Record<TemplateKeyMap, StringSettingKey> = {
  "admin:html": "email_tpl_admin_html",
  "admin:subject": "email_tpl_admin_subject",
  "admin:text": "email_tpl_admin_text",
  "confirmation:html": "email_tpl_confirmation_html",
  "confirmation:subject": "email_tpl_confirmation_subject",
  "confirmation:text": "email_tpl_confirmation_text",
};

// ---------------------------------------------------------------------------
// String setting keys — plaintext and encrypted
// ---------------------------------------------------------------------------

/** Plaintext string config keys (stored unencrypted, default ""). */
const PLAINTEXT_KEYS = [
  CONFIG_KEYS.TERMS_AND_CONDITIONS,
  CONFIG_KEYS.BULK_EMAIL_DRAFT,
  CONFIG_KEYS.EMAIL_PROVIDER,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.CURRENT_TASK,
  CONFIG_KEYS.PUBLIC_KEY,
  CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
  CONFIG_KEYS.SQUARE_LOCATION_ID,
  CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
  CONFIG_KEYS.SUMUP_MERCHANT_CODE,
  CONFIG_KEYS.LATEST_SCRIPT_VERSION,
  CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME,
  CONFIG_KEYS.SUPERUSER_CHOICE,
  CONFIG_KEYS.SUPPORT_FORM_LAST_SUBMITTED,
  CONFIG_KEYS.LISTING_COLUMN_ORDER,
  CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
  CONFIG_KEYS.LAST_PRUNED_PAYMENTS,
  CONFIG_KEYS.LAST_PRUNED_SESSIONS,
  CONFIG_KEYS.LAST_PRUNED_STRINGS,
  CONFIG_KEYS.LAST_PRUNED_SUMUP,
  CONFIG_KEYS.LAST_PRUNED_LOGINS,
  CONFIG_KEYS.LAST_PRUNED_TOKENS,
  CONFIG_KEYS.LAST_PRUNED_CONTACTS,
  CONFIG_KEYS.LAST_PRUNED_ORPHANS,
  CONFIG_KEYS.SMS_GATEWAY_BASE_URL,
] as const;

/** Encrypted string config keys (decrypted during loadKeys, default ""). */
const ENCRYPTED_KEYS = [
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  CONFIG_KEYS.WEBSITE_TITLE,
  CONFIG_KEYS.HOMEPAGE_TEXT,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.ORDER_INTRO_TEXT,
  CONFIG_KEYS.STRIPE_SECRET_KEY,
  CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
  CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
  CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
  CONFIG_KEYS.SUMUP_API_KEY,
  CONFIG_KEYS.EMBED_HOSTS,
  CONFIG_KEYS.EMAIL_API_KEY,
  CONFIG_KEYS.EMAIL_FROM_ADDRESS,
  CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT,
  CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML,
  CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT,
  CONFIG_KEYS.EMAIL_TPL_ADMIN_SUBJECT,
  CONFIG_KEYS.EMAIL_TPL_ADMIN_HTML,
  CONFIG_KEYS.EMAIL_TPL_ADMIN_TEXT,
  CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID,
  CONFIG_KEYS.APPLE_WALLET_TEAM_ID,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
  CONFIG_KEYS.APPLE_WALLET_WWDR_CERT,
  CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
  CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
  CONFIG_KEYS.SMS_GATEWAY_USERNAME,
  CONFIG_KEYS.SMS_GATEWAY_PASSWORD,
  CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
] as const;

/** Union of all string-setting snapshot keys. */
export type StringSettingKey =
  | (typeof PLAINTEXT_KEYS)[number]
  | (typeof ENCRYPTED_KEYS)[number];

/** All string setting fields: empty string means "no value". */
type StringSettingFields = Record<StringSettingKey, string>;

/** Generate empty-string defaults for every string setting field. */
const stringSettingDefaults = Object.fromEntries(
  [...PLAINTEXT_KEYS, ...ENCRYPTED_KEYS].map((k) => [k, ""]),
) as StringSettingFields;

// ---------------------------------------------------------------------------
// Full snapshot type + initial data
// ---------------------------------------------------------------------------

/** Non-string snapshot fields that need explicit types. */
type SpecificFields = {
  country: string;
  theme: Theme;
  show_public_site: boolean;
  show_public_api: boolean;
  calendar_feeds_enabled: boolean;
  calendar_feeds_group_by: string;
  contact_form_enabled: boolean;
  order_enabled: boolean;
  has_logistics: boolean;
  payment_provider: PaymentProviderType | null;
  payment_provider_setting: PaymentProviderSetting | null;
  booking_fee: string;
  square_sandbox: boolean;
  superuser_choice: SuperuserChoice;
  currency: string;
  timezone: string;
  phone_prefix: string;
  auto_purge_orphans: boolean;
  orphan_purge_retention: string;
};

/** Full settings snapshot type. */
export type SettingsData = SpecificFields & StringSettingFields;

/** Mutable snapshot of all settings. Populated by loadKeys(). */
const data: SettingsData = {
  auto_purge_orphans: true,
  booking_fee: "0",
  calendar_feeds_enabled: false,
  calendar_feeds_group_by: "attendees",
  contact_form_enabled: false,
  country: DEFAULT_COUNTRY,
  currency: "GBP",
  has_logistics: false,
  order_enabled: false,
  orphan_purge_retention: DEFAULT_ORPHAN_RETENTION,
  payment_provider: null,
  payment_provider_setting: null,
  phone_prefix: "+44",
  show_public_api: false,
  show_public_site: false,
  square_sandbox: false,
  theme: "light",
  timezone: DEFAULT_TIMEZONE,
  ...stringSettingDefaults,
  superuser_choice: "",
};

const defaults: Readonly<SettingsData> = { ...data };

/** Type-safe setter for a single snapshot field. */
const setSnapshotField = <K extends keyof SettingsData>(
  key: K,
  value: SettingsData[K],
): void => {
  data[key] = value;
};

/** Test overrides — survive invalidateCache(), cleared by clearTestOverrides(). */
const [getTestOverrides, setTestOverrides] = lazyRef<Record<string, unknown>>(
  () => ({}),
);

/**
 * Snapshot fields that derive from a different config key, for the read audit.
 * Country drives currency/timezone/phone_prefix; the payment-provider setting
 * shares PAYMENT_PROVIDER's row. Every other field's name equals its config key.
 */
const AUDIT_KEY_OVERRIDES: Record<string, string> = {
  currency: CONFIG_KEYS.COUNTRY,
  payment_provider_setting: CONFIG_KEYS.PAYMENT_PROVIDER,
  phone_prefix: CONFIG_KEYS.COUNTRY,
  timezone: CONFIG_KEYS.COUNTRY,
};

/** Map a snapshot field name to the config key whose load satisfies it. */
const auditKeyFor = (field: string): string =>
  AUDIT_KEY_OVERRIDES[field] ?? field;

/** Read a snapshot value, checking test overrides first. */
const snap = <K extends keyof SettingsData>(key: K): SettingsData[K] => {
  const overrides = getTestOverrides();
  // A test override supplies the value directly, so the read doesn't depend on
  // a declared load — skip the audit (production never has overrides).
  if (key in overrides) return overrides[key] as SettingsData[K];
  recordSettingRead(auditKeyFor(key as string));
  return data[key];
};

// ---------------------------------------------------------------------------
// Raw DB operations (internal)
// ---------------------------------------------------------------------------

/** Read a raw string from the cache. Returns null if missing or cache not loaded. */
const getRawCached = (key: string): string | null => {
  recordSettingRead(key);
  return getCacheState().values.get(key) ?? null;
};

/** Mutate the raw cache if it's currently fresh; no-op otherwise. */
const syncCache = (mutate: (state: CacheState) => void): void => {
  if (isCacheFresh()) mutate(getCacheState());
};

/** Write a setting to the DB and update the raw cache in-place. */
const writeRaw = async (key: string, value: string): Promise<void> => {
  await executeWithoutCacheInvalidation(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    [key, value],
  );
  // A write makes the key's value known this request, so reading it back is
  // safe in production too — record it as available for the read audit.
  recordSettingsLoaded([key]);
  syncCache((s) => {
    s.values.set(key, value);
    s.loaded.add(key);
  });
};

/** Delete a setting from the DB and remove it from the raw cache. */
const deleteRaw = async (key: string): Promise<void> => {
  await executeWithoutCacheInvalidation("DELETE FROM settings WHERE key = ?", [
    key,
  ]);
  recordSettingsLoaded([key]);
  syncCache((s) => {
    s.values.delete(key);
    s.loaded.add(key);
  });
};

/** Write a setting or delete it if value is empty. */
const writeOrDelete = (key: string, value: string): Promise<void> => {
  if (value === "") return deleteRaw(key);
  return writeRaw(key, value);
};

/** Encrypt then write (empty string deletes the key). */
const writeEncrypted = async (key: string, value: string): Promise<void> => {
  if (!value) return deleteRaw(key);
  await writeRaw(key, await encrypt(value));
};

/**
 * Factory: run `writer` then mirror the value into the snapshot. Accepts any
 * string key so it satisfies `EncryptedUpdateFn` for wallet factories; callers
 * always pass a `CONFIG_KEYS.*` value that is a real snapshot field.
 */
const stringUpdate =
  (writer: (key: string, value: string) => Promise<void>) =>
  (key: string) =>
  async (v: string): Promise<void> => {
    await writer(key, v);
    setSnapshotField(key as StringSettingKey, v);
  };

const encryptedUpdate: EncryptedUpdateFn = stringUpdate(writeEncrypted);
const plaintextUpdate: EncryptedUpdateFn = stringUpdate(writeOrDelete);

// ---------------------------------------------------------------------------
// Generated string accessors
//
// One entry here creates both the sync getter (settings.<name>) and, unless
// readOnly, the matching writer (settings.update.<name>). Whether the writer
// encrypts is derived from ENCRYPTED_KEYS membership, so adding a simple
// string setting means: a CONFIG_KEYS entry, a PLAINTEXT_KEYS/ENCRYPTED_KEYS
// entry, and one line below.
// ---------------------------------------------------------------------------

type AccessorSpec = { key: StringSettingKey; readOnly?: true };

const STRING_ACCESSORS = {
  attendeeColumnOrder: { key: CONFIG_KEYS.ATTENDEE_COLUMN_ORDER },
  bulkEmailDraft: { key: CONFIG_KEYS.BULK_EMAIL_DRAFT },
  bunnySubdomain: { key: CONFIG_KEYS.BUNNY_SUBDOMAIN },
  businessEmail: { key: CONFIG_KEYS.BUSINESS_EMAIL },
  contactPageText: { key: CONFIG_KEYS.CONTACT_PAGE_TEXT },
  currentTask: { key: CONFIG_KEYS.CURRENT_TASK },
  customDomain: { key: CONFIG_KEYS.CUSTOM_DOMAIN },
  // readOnly: settings.update.customDomainLastValidated writes a timestamp
  customDomainLastValidated: {
    key: CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
    readOnly: true,
  },
  embedHosts: { key: CONFIG_KEYS.EMBED_HOSTS },
  headerImageUrl: { key: CONFIG_KEYS.HEADER_IMAGE_URL },
  homepageText: { key: CONFIG_KEYS.HOMEPAGE_TEXT },
  lastPrunedContacts: { key: CONFIG_KEYS.LAST_PRUNED_CONTACTS },
  lastPrunedLogins: { key: CONFIG_KEYS.LAST_PRUNED_LOGINS },
  lastPrunedOrphans: { key: CONFIG_KEYS.LAST_PRUNED_ORPHANS },
  lastPrunedPayments: { key: CONFIG_KEYS.LAST_PRUNED_PAYMENTS },
  lastPrunedSessions: { key: CONFIG_KEYS.LAST_PRUNED_SESSIONS },
  lastPrunedStrings: { key: CONFIG_KEYS.LAST_PRUNED_STRINGS },
  lastPrunedSumup: { key: CONFIG_KEYS.LAST_PRUNED_SUMUP },
  lastPrunedTokens: { key: CONFIG_KEYS.LAST_PRUNED_TOKENS },
  latestScriptVersion: { key: CONFIG_KEYS.LATEST_SCRIPT_VERSION },
  latestScriptVersionName: { key: CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME },
  listingColumnOrder: { key: CONFIG_KEYS.LISTING_COLUMN_ORDER },
  orderIntroText: { key: CONFIG_KEYS.ORDER_INTRO_TEXT },
  // readOnly: key material is only written by setup/password flows
  publicKey: { key: CONFIG_KEYS.PUBLIC_KEY, readOnly: true },
  smsGatewayBaseUrl: { key: CONFIG_KEYS.SMS_GATEWAY_BASE_URL },
  smsGatewayPassphrase: { key: CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE },
  smsGatewayPassword: { key: CONFIG_KEYS.SMS_GATEWAY_PASSWORD },
  smsGatewayUsername: { key: CONFIG_KEYS.SMS_GATEWAY_USERNAME },
  smsGatewayWebhookSecret: { key: CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET },
  // readOnly: settings.update.supportFormLastSubmitted writes a timestamp
  supportFormLastSubmitted: {
    key: CONFIG_KEYS.SUPPORT_FORM_LAST_SUBMITTED,
    readOnly: true,
  },
  terms: { key: CONFIG_KEYS.TERMS_AND_CONDITIONS },
  websiteTitle: { key: CONFIG_KEYS.WEBSITE_TITLE },
  wrappedPrivateKey: { key: CONFIG_KEYS.WRAPPED_PRIVATE_KEY, readOnly: true },
} as const satisfies Record<string, AccessorSpec>;

type StringAccessors = typeof STRING_ACCESSORS;

/** Sync getter per accessor entry. */
type GeneratedGetters = { readonly [K in keyof StringAccessors]: string };

/** Writable accessor names (entries without readOnly). */
type WritableAccessor = {
  [K in keyof StringAccessors]: StringAccessors[K] extends { readOnly: true }
    ? never
    : K;
}[keyof StringAccessors];

/** Async writer per writable accessor entry. */
type GeneratedUpdaters = {
  [K in WritableAccessor]: (v: string) => Promise<void>;
};

const ENCRYPTED_KEY_SET: ReadonlySet<string> = new Set(ENCRYPTED_KEYS);

/** Build the generated getters and updaters in one pass over the registry. */
const buildStringAccessors = (): {
  getters: GeneratedGetters;
  updaters: GeneratedUpdaters;
} => {
  const getters = {};
  const updaters: Record<string, (v: string) => Promise<void>> = {};
  for (const [name, spec] of Object.entries<AccessorSpec>(STRING_ACCESSORS)) {
    Object.defineProperty(getters, name, {
      enumerable: true,
      get: () => snap(spec.key),
    });
    if (spec.readOnly) continue;
    const update = ENCRYPTED_KEY_SET.has(spec.key)
      ? encryptedUpdate
      : plaintextUpdate;
    updaters[name] = update(spec.key);
  }
  return {
    getters: getters as GeneratedGetters,
    updaters: updaters as GeneratedUpdaters,
  };
};

const stringAccessors = buildStringAccessors();

/**
 * Copy property descriptors (preserving getters) from `props` onto `target`.
 * A spread would eagerly evaluate the getters instead.
 */
const withProperties = <T extends object, P extends object>(
  target: T,
  props: P,
): T & P => {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(props));
  return target as T & P;
};

/** Factory: write a raw string and mirror into a specific snapshot field. */
const rawUpdate =
  <K extends keyof SettingsData>(
    configKey: string,
    field: K,
    serialize: (v: SettingsData[K]) => string = String,
  ) =>
  async (v: SettingsData[K]): Promise<void> => {
    await writeRaw(configKey, serialize(v));
    setSnapshotField(field, v);
  };

/** Factory: write a boolean as "true"/"false" and mirror into the snapshot. */
const boolUpdate = <K extends BoolSettingKey>(configKey: string, field: K) =>
  rawUpdate(configKey, field, (v) => (v ? "true" : "false"));

/** Snapshot keys whose value is a boolean. */
type BoolSettingKey = {
  [K in keyof SettingsData]: SettingsData[K] extends boolean ? K : never;
}[keyof SettingsData];

// ---------------------------------------------------------------------------
// Snapshot builder — called by loadKeys()
// ---------------------------------------------------------------------------

type CountryInfo = ReturnType<typeof getCountry>;
const applyCountryDerived = (info: CountryInfo): void => {
  data.currency = info.currency;
  data.timezone = info.timezone;
  data.phone_prefix = info.phonePrefix;
};

/**
 * Per-key resolvers for the non-string snapshot fields. A config key may drive
 * more than one snapshot field (COUNTRY → currency/timezone/phone_prefix;
 * PAYMENT_PROVIDER → provider + setting). `raw` is undefined when the key is
 * absent from the DB, in which case the default is applied.
 */
const SPECIAL_APPLIERS: Record<string, (raw: string | undefined) => void> = {
  [CONFIG_KEYS.COUNTRY]: (raw) => {
    const country = raw || DEFAULT_COUNTRY;
    data.country = country;
    applyCountryDerived(getCountry(country));
  },
  [CONFIG_KEYS.THEME]: (raw) => {
    data.theme = raw === "dark" ? "dark" : "light";
  },
  [CONFIG_KEYS.SHOW_PUBLIC_SITE]: (raw) => {
    data.show_public_site = raw === "true";
  },
  [CONFIG_KEYS.SHOW_PUBLIC_API]: (raw) => {
    data.show_public_api = raw === "true";
  },
  [CONFIG_KEYS.CALENDAR_FEEDS_ENABLED]: (raw) => {
    data.calendar_feeds_enabled = raw === "true";
  },
  [CONFIG_KEYS.CALENDAR_FEEDS_GROUP_BY]: (raw) => {
    data.calendar_feeds_group_by =
      raw === "listings" ? "listings" : "attendees";
  },
  [CONFIG_KEYS.CONTACT_FORM_ENABLED]: (raw) => {
    data.contact_form_enabled = raw === "true";
  },
  [CONFIG_KEYS.ORDER_ENABLED]: (raw) => {
    data.order_enabled = raw === "true";
  },
  // Defaults ON: only an explicit "false" disows automatic orphan purging.
  [CONFIG_KEYS.AUTO_PURGE_ORPHANS]: (raw) => {
    data.auto_purge_orphans = raw !== "false";
  },
  // Coerce an absent/garbled value back to the default age, so a bad row can
  // never widen the purge window.
  [CONFIG_KEYS.ORPHAN_PURGE_RETENTION]: (raw) => {
    data.orphan_purge_retention =
      raw && isOrphanRetentionValue(raw) ? raw : DEFAULT_ORPHAN_RETENTION;
  },
  [CONFIG_KEYS.HAS_LOGISTICS]: (raw) => {
    data.has_logistics = raw === "true";
  },
  [CONFIG_KEYS.PAYMENT_PROVIDER]: (raw) => {
    data.payment_provider = raw && isPaymentProvider(raw) ? raw : null;
    data.payment_provider_setting =
      raw && isPaymentProviderSetting(raw) ? raw : null;
  },
  [CONFIG_KEYS.BOOKING_FEE]: (raw) => {
    data.booking_fee = raw ?? "0";
  },
  [CONFIG_KEYS.SQUARE_SANDBOX]: (raw) => {
    data.square_sandbox = raw === "true";
  },
};

const PLAINTEXT_KEY_SET = new Set<string>(PLAINTEXT_KEYS);

/** Every config key that maps to a snapshot field, in load order. */
export const SNAPSHOT_KEYS: readonly string[] = [
  ...Object.keys(SPECIAL_APPLIERS),
  ...PLAINTEXT_KEYS,
  ...ENCRYPTED_KEYS,
];

/**
 * All keys that populate the snapshot plus the setup-complete flag. Equivalent
 * to the former `loadAll` SELECT * in terms of what affects request behaviour.
 * Use in tests and in pre-load bundles that need every setting.
 */
export const ALL_SETTINGS_KEYS: readonly string[] = [
  ...SNAPSHOT_KEYS,
  CONFIG_KEYS.SETUP_COMPLETE,
];

/**
 * Resolve one config key from `values` into the snapshot. Encrypted keys are
 * decrypted (hence async); plaintext and special keys are synchronous. Keys
 * with no snapshot field (e.g. SETUP_COMPLETE) are no-ops — they live in the
 * raw cache only.
 */
const applyKey = async (
  key: string,
  values: Map<string, string>,
): Promise<void> => {
  const special = SPECIAL_APPLIERS[key];
  if (special) return special(values.get(key));
  if (ENCRYPTED_KEY_SET.has(key)) {
    const v = values.get(key);
    setSnapshotField(key as StringSettingKey, v ? await decrypt(v) : "");
    return;
  }
  if (PLAINTEXT_KEY_SET.has(key)) {
    setSnapshotField(key as StringSettingKey, values.get(key) ?? "");
  }
};

/** Resolve a batch of keys into the snapshot, decrypting in parallel. */
const applyKeys = async (
  keys: readonly string[],
  values: Map<string, string>,
): Promise<void> => {
  await Promise.all(keys.map((key) => applyKey(key, values)));
};

// ---------------------------------------------------------------------------
// loadKeys / invalidateCache
// ---------------------------------------------------------------------------

/** Reset the raw cache to a fresh, empty state stamped at the current time. */
const resetCache = (): CacheState => {
  setCacheState(null);
  const s = getCacheState();
  s.time = nowMs();
  return s;
};

/**
 * Load only the given config keys, fetching just the ones not already resolved
 * in the current fresh cache (one `WHERE key IN (...)` query) and decrypting
 * only those.
 */
const loadKeys = async (keys: readonly string[]): Promise<void> => {
  // Record everything declared this request, regardless of cache state, so the
  // read audit compares against the full declared set (not just cache misses).
  recordSettingsLoaded(keys);
  const s = isCacheFresh() ? getCacheState() : resetCache();
  const missing = unique([...keys]).filter((k) => !s.loaded.has(k));
  if (missing.length === 0) return;
  const rows = await queryAll<Settings>(
    `SELECT key, value FROM settings WHERE key IN (${missing
      .map(() => "?")
      .join(", ")})`,
    missing,
  );
  for (const row of rows) s.values.set(row.key, row.value);
  await applyKeys(missing, s.values);
  for (const key of missing) s.loaded.add(key);
};

/** Full invalidation — clears raw cache AND resets snapshot to defaults. */
const invalidateCache = (): void => {
  setCacheState(null);
  for (const key of Object.keys(defaults) as (keyof SettingsData)[]) {
    setSnapshotField(key, defaults[key]);
  }
};

registerTableInvalidation(["settings"], invalidateCache);

// ---------------------------------------------------------------------------
// Setup-complete permanent cache
// ---------------------------------------------------------------------------

const [getSetupCompleteCache, setSetupCompleteCache] = lazyRef<boolean>(
  () => false,
);
const [getSetupConfirmed, setSetupConfirmed] = lazyRef<boolean>(() => false);

const isSetupComplete = async (): Promise<boolean> => {
  const confirmed = getSetupConfirmed();
  const cached = getSetupCompleteCache();
  if (confirmed && cached) return true;
  // Need the raw cache for this check — fetch only the one key we read.
  if (!isKeyLoaded(CONFIG_KEYS.SETUP_COMPLETE)) {
    await loadKeys([CONFIG_KEYS.SETUP_COMPLETE]);
  }
  const isComplete = getRawCached(CONFIG_KEYS.SETUP_COMPLETE) === "true";
  if (isComplete) {
    setSetupCompleteCache(true);
    setSetupConfirmed(true);
  }
  return isComplete;
};

const clearSetupCompleteCache = (): void => {
  setSetupCompleteCache(null);
  setSetupConfirmed(null);
};

// ---------------------------------------------------------------------------
// Initial setup
// ---------------------------------------------------------------------------

const completeSetup = async (
  username: string,
  adminPassword: string,
  country: string,
): Promise<void> => {
  const hashedPassword = await hashPassword(adminPassword);
  const dataKey = await generateDataKey();
  const { publicKey, privateKey } = await generateKeyPair();
  const kek = await deriveKEK(hashedPassword);
  const wrappedDataKey = await wrapKey(dataKey, kek);
  await createUser(username, hashedPassword, wrappedDataKey, "owner");
  const encryptedPrivateKey = await encryptWithKey(privateKey, dataKey);
  await writeRaw(CONFIG_KEYS.WRAPPED_PRIVATE_KEY, encryptedPrivateKey);
  await writeRaw(CONFIG_KEYS.PUBLIC_KEY, publicKey);
  await writeRaw(CONFIG_KEYS.COUNTRY, country);
  await writeRaw(CONFIG_KEYS.SETUP_COMPLETE, "true");

  // Setup flips the global routing gate. Drop any partially-loaded settings
  // snapshot from pre-setup requests so the next request cannot keep serving
  // stale defaults (notably a cached missing setup_complete row). Mark the
  // permanent setup gate as confirmed so the immediate /setup/complete redirect
  // succeeds without another DB round-trip.
  invalidateCache();
  setSetupCompleteCache(true);
  setSetupConfirmed(true);
};

// ---------------------------------------------------------------------------
// Password update
// ---------------------------------------------------------------------------

const updateUserPassword = async (
  userId: number,
  oldPasswordHash: string,
  oldWrappedDataKey: string,
  newPassword: string,
): Promise<boolean> => {
  const oldKek = await deriveKEK(oldPasswordHash);
  let dk: CryptoKey;
  try {
    dk = await unwrapKey(oldWrappedDataKey, oldKek);
  } catch {
    return false;
  }
  const newHash = await hashPassword(newPassword);
  const encryptedNewHash = await encrypt(newHash);
  const newKek = await deriveKEK(newHash);
  const newWrappedDataKey = await wrapKey(dk, newKek);
  await execute(
    "UPDATE users SET password_hash = ?, wrapped_data_key = ? WHERE id = ?",
    [encryptedNewHash, newWrappedDataKey, userId],
  );
  invalidateUsersCache();
  await deleteAllSessions();
  return true;
};

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Current-task guard — prevents duplicate heavy operations
// ---------------------------------------------------------------------------

/**
 * Run `fn` while holding the `current_task` lock for `taskName`.
 * If a task is already in progress, returns `{ ok: false, error }`.
 * The lock is always cleared when `fn` completes (success or error).
 *
 * Uses an atomic UPDATE … WHERE value = '' to avoid race conditions
 * between concurrent requests on the same node.
 */
const withCurrentTask = async <T>(
  taskName: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  // Ensure the row exists (no-op if already present)
  await executeWithoutCacheInvalidation(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')",
    [CONFIG_KEYS.CURRENT_TASK],
  );
  // Atomic claim: only succeeds when no task is running
  const claim = await executeWithoutCacheInvalidation(
    "UPDATE settings SET value = ? WHERE key = ? AND value = ''",
    [taskName, CONFIG_KEYS.CURRENT_TASK],
  );
  if (claim.rowsAffected === 0) {
    return {
      error: "Another task is already in progress",
      ok: false,
    };
  }
  syncCache((s) => {
    s.values.set(CONFIG_KEYS.CURRENT_TASK, taskName);
    s.loaded.add(CONFIG_KEYS.CURRENT_TASK);
  });
  setSnapshotField("current_task", taskName);
  try {
    const value = await fn();
    return { ok: true, value };
  } finally {
    await writeOrDelete(CONFIG_KEYS.CURRENT_TASK, "");
    setSnapshotField("current_task", "");
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_WEBSITE_TITLE_LENGTH = 128;
export const MAX_EMAIL_TEMPLATE_LENGTH = 51_200;

// ---------------------------------------------------------------------------
// The settings namespace
// ---------------------------------------------------------------------------

const settingsBase = {
  // --- Apple Wallet ---
  appleWallet: createAppleWalletReadSettings(snap as (k: string) => string),
  get autoPurgeOrphans(): boolean {
    return snap("auto_purge_orphans");
  },
  get bookingFee(): string {
    return snap("booking_fee");
  },

  // -----------------------------------------------------------------------
  // Sync reads — all populated by loadKeys()
  // -----------------------------------------------------------------------

  get calendarFeedsEnabled(): boolean {
    return snap("calendar_feeds_enabled");
  },
  get calendarFeedsGroupBy(): "attendees" | "listings" {
    const value = snap("calendar_feeds_group_by");
    return value === "listings" ? "listings" : "attendees";
  },

  /** Remove specific test override keys (falls back to data). */
  clearTestOverride(...keys: (keyof SettingsData)[]): void {
    const current = getTestOverrides();
    for (const key of keys) {
      delete current[key];
    }
  },

  /** Clear all test overrides. */
  clearTestOverrides(): void {
    setTestOverrides(null);
  },

  get contactFormEnabled(): boolean {
    return snap("contact_form_enabled");
  },

  get country(): string {
    return snap("country");
  },

  // Derived from country
  get currency(): string {
    return snap("currency");
  },

  // --- Email ---
  email: {
    get apiKey(): string {
      return snap("email_api_key");
    },
    get fromAddress(): string {
      return snap("email_from_address");
    },
    get hasApiKey(): boolean {
      return snap("email_api_key") !== "";
    },
    get provider(): string {
      return snap("email_provider");
    },
    template(type: EmailTemplateType, format: EmailTemplateFormat): string {
      return snap(TEMPLATE_KEYS[`${type}:${format}`]);
    },
    templateSet(type: EmailTemplateType): {
      subject: string;
      html: string;
      text: string;
    } {
      return {
        html: this.template(type, "html"),
        subject: this.template(type, "subject"),
        text: this.template(type, "text"),
      };
    },
  },
  /** Read a raw (possibly encrypted) value from the cache. */
  getCachedRaw: getRawCached,

  // --- Google Wallet ---
  googleWallet: createGoogleWalletReadSettings(snap as (k: string) => string),

  get hasLogistics(): boolean {
    return snap("has_logistics");
  },
  invalidateCache,
  // --- Core ---
  loadKeys,
  get orderEnabled(): boolean {
    return snap("order_enabled");
  },
  get orphanPurgeRetention(): string {
    return snap("orphan_purge_retention");
  },
  get paymentProvider(): PaymentProviderType | null {
    return snap("payment_provider");
  },
  get paymentProviderSetting(): PaymentProviderSetting | null {
    return snap("payment_provider_setting");
  },
  get phonePrefix(): string {
    return snap("phone_prefix");
  },

  /** Set test overrides (survive invalidateCache, cleared by clearTestOverrides). */
  setForTest(overrides: Partial<SettingsData>): void {
    const current = getTestOverrides();
    for (const [k, v] of Object.entries(overrides)) {
      current[k] = v;
    }
  },

  /** Write a raw value to the DB (low-level, prefer update.*). */
  setRaw: writeRaw,

  // --- Setup & auth ---
  setup: {
    clearCache: clearSetupCompleteCache,
    complete: completeSetup,
    isComplete: isSetupComplete,
  },
  get showPublicApi(): boolean {
    return snap("show_public_api");
  },
  get showPublicSite(): boolean {
    return snap("show_public_site");
  },

  // --- SMS gateway ---
  smsGateway: {
    get hasPassphrase(): boolean {
      return snap("sms_gateway_passphrase") !== "";
    },
    get hasPassword(): boolean {
      return snap("sms_gateway_password") !== "";
    },
    get hasWebhookSecret(): boolean {
      return snap("sms_gateway_webhook_secret") !== "";
    },
  },

  // --- Square ---
  square: {
    get accessToken(): string {
      return snap("square_access_token");
    },
    get hasToken(): boolean {
      return snap("square_access_token") !== "";
    },
    get locationId(): string {
      return snap("square_location_id");
    },
    get sandbox(): boolean {
      return snap("square_sandbox");
    },
    get webhookSignatureKey(): string {
      return snap("square_webhook_signature_key");
    },
  },

  // --- Stripe ---
  stripe: {
    get hasKey(): boolean {
      return snap("stripe_secret_key") !== "";
    },
    get keyMode(): "test" | "live" | null {
      return keyModeOf(snap("stripe_secret_key"));
    },
    get secretKey(): string {
      return snap("stripe_secret_key");
    },
    get webhookEndpointId(): string {
      return snap("stripe_webhook_endpoint_id");
    },
    get webhookSecret(): string {
      return snap("stripe_webhook_secret");
    },
  },

  // --- SumUp ---
  sumup: {
    get apiKey(): string {
      return snap("sumup_api_key");
    },
    get hasKey(): boolean {
      return snap("sumup_api_key") !== "";
    },
    get keyMode(): "test" | "live" | null {
      return keyModeOf(snap("sumup_api_key"));
    },
    get merchantCode(): string {
      return snap("sumup_merchant_code");
    },
  },

  // --- Superuser ---
  get superuserChoice(): SuperuserChoice {
    const choice = snap("superuser_choice");
    return isSuperuserChoice(choice) ? choice : "";
  },
  get theme(): Theme {
    return snap("theme");
  },
  get timezone(): string {
    return snap("timezone");
  },

  // -----------------------------------------------------------------------
  // Async writes — settings.update.*
  // -----------------------------------------------------------------------
  update: {
    ...stringAccessors.updaters,
    // --- Apple Wallet writes ---
    appleWallet: createAppleWalletUpdateSettings(encryptedUpdate),
    autoPurgeOrphans: boolUpdate(
      CONFIG_KEYS.AUTO_PURGE_ORPHANS,
      "auto_purge_orphans",
    ),
    bookingFee: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.BOOKING_FEE, v);
      data.booking_fee = v || "0";
    },
    calendarFeedsEnabled: boolUpdate(
      CONFIG_KEYS.CALENDAR_FEEDS_ENABLED,
      "calendar_feeds_enabled",
    ),
    calendarFeedsGroupBy: rawUpdate(
      CONFIG_KEYS.CALENDAR_FEEDS_GROUP_BY,
      "calendar_feeds_group_by",
    ) as (v: "attendees" | "listings") => Promise<void>,
    clearPaymentProvider: async (): Promise<void> => {
      await deleteRaw(CONFIG_KEYS.PAYMENT_PROVIDER);
      data.payment_provider = null;
      data.payment_provider_setting = null;
    },
    contactFormEnabled: boolUpdate(
      CONFIG_KEYS.CONTACT_FORM_ENABLED,
      "contact_form_enabled",
    ),
    country: async (v: string): Promise<void> => {
      await writeRaw(CONFIG_KEYS.COUNTRY, v);
      data.country = v;
      applyCountryDerived(getCountry(v));
    },
    customDomainLastValidated: async (): Promise<void> => {
      const ts = new Date().toISOString();
      await writeRaw(CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED, ts);
      data.custom_domain_last_validated = ts;
    },

    // --- Email writes ---
    email: {
      apiKey: encryptedUpdate(CONFIG_KEYS.EMAIL_API_KEY),
      fromAddress: encryptedUpdate(CONFIG_KEYS.EMAIL_FROM_ADDRESS),
      provider: plaintextUpdate(CONFIG_KEYS.EMAIL_PROVIDER),
      template: async (
        type: EmailTemplateType,
        format: EmailTemplateFormat,
        content: string,
      ): Promise<void> => {
        const key = TEMPLATE_KEYS[`${type}:${format}`];
        await writeEncrypted(key, content);
        setSnapshotField(key, content);
      },
    },
    // --- Google Wallet writes ---
    googleWallet: createGoogleWalletUpdateSettings(encryptedUpdate),
    hasLogistics: boolUpdate(CONFIG_KEYS.HAS_LOGISTICS, "has_logistics"),
    orderEnabled: boolUpdate(CONFIG_KEYS.ORDER_ENABLED, "order_enabled"),
    orphanPurgeRetention: rawUpdate(
      CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
      "orphan_purge_retention",
    ),
    paymentProvider: async (v: PaymentProviderType): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, v);
      data.payment_provider = v;
      data.payment_provider_setting = v;
    },
    setPaymentProviderNone: async (): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "none");
      data.payment_provider = null;
      data.payment_provider_setting = "none";
    },
    showPublicApi: boolUpdate(CONFIG_KEYS.SHOW_PUBLIC_API, "show_public_api"),
    showPublicSite: boolUpdate(
      CONFIG_KEYS.SHOW_PUBLIC_SITE,
      "show_public_site",
    ),

    // --- Square writes ---
    square: {
      accessToken: encryptedUpdate(CONFIG_KEYS.SQUARE_ACCESS_TOKEN),
      locationId: rawUpdate(
        CONFIG_KEYS.SQUARE_LOCATION_ID,
        "square_location_id",
      ),
      sandbox: boolUpdate(CONFIG_KEYS.SQUARE_SANDBOX, "square_sandbox"),
      webhookSignatureKey: encryptedUpdate(
        CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
      ),
    },
    // --- Stripe writes ---
    stripe: {
      secretKey: encryptedUpdate(CONFIG_KEYS.STRIPE_SECRET_KEY),
      webhookConfig: async (config: {
        secret: string;
        endpointId: string;
      }): Promise<void> => {
        await writeRaw(
          CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
          await encrypt(config.secret),
        );
        await writeRaw(
          CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
          config.endpointId,
        );
        data.stripe_webhook_secret = config.secret;
        data.stripe_webhook_endpoint_id = config.endpointId;
      },
    },
    // --- SumUp writes ---
    sumup: {
      apiKey: encryptedUpdate(CONFIG_KEYS.SUMUP_API_KEY),
      merchantCode: plaintextUpdate(CONFIG_KEYS.SUMUP_MERCHANT_CODE),
    },
    superuserChoice: plaintextUpdate(CONFIG_KEYS.SUPERUSER_CHOICE) as (
      v: SuperuserChoice,
    ) => Promise<void>,
    supportFormLastSubmitted: async (): Promise<void> => {
      const ts = new Date().toISOString();
      await writeRaw(CONFIG_KEYS.SUPPORT_FORM_LAST_SUBMITTED, ts);
      data.support_form_last_submitted = ts;
    },
    theme: rawUpdate(CONFIG_KEYS.THEME, "theme") as (v: Theme) => Promise<void>,
  },
  updateUserPassword,
  withCurrentTask,
};

export const settings = withProperties(settingsBase, stringAccessors.getters);
