/**
 * Settings — sync reads, async writes.
 *
 * Call `settings.loadAll()` once per request to populate the snapshot.
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

import { lazyRef } from "#fp";
import { registerCache } from "#shared/cache-registry.ts";
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
import { getDb, queryAll } from "#shared/db/client.ts";
import { deleteAllSessions } from "#shared/db/sessions.ts";
import { createUser, invalidateUsersCache } from "#shared/db/users.ts";
import { nowMs } from "#shared/now.ts";
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
  BOOKING_FEE: "booking_fee",
  BULK_EMAIL_DRAFT: "bulk_email_draft",
  BUNNY_SUBDOMAIN: "bunny_subdomain",
  BUSINESS_EMAIL: "business_email",
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
  HEADER_IMAGE_URL: "header_image_url",
  HOMEPAGE_TEXT: "homepage_text",
  LAST_PRUNED_LOGINS: "last_pruned_logins",
  LAST_PRUNED_PAYMENTS: "last_pruned_payments",
  LAST_PRUNED_SESSIONS: "last_pruned_sessions",
  LAST_PRUNED_SUMUP: "last_pruned_sumup",
  LAST_PRUNED_TOKENS: "last_pruned_tokens",
  LATEST_SCRIPT_VERSION: "latest_script_version",
  LATEST_SCRIPT_VERSION_NAME: "latest_script_version_name",
  LISTING_COLUMN_ORDER: "listing_column_order",
  PAYMENT_PROVIDER: "payment_provider",
  PUBLIC_KEY: "public_key",
  QUOTE_ENABLED: "quote_enabled",
  QUOTE_INTRO_TEXT: "quote_intro_text",
  SETUP_COMPLETE: "setup_complete",
  SHOW_PUBLIC_API: "show_public_api",
  SHOW_PUBLIC_SITE: "show_public_site",
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
  TERMS_AND_CONDITIONS: "terms_and_conditions",
  THEME: "theme",
  WEBSITE_TITLE: "website_title",
  WRAPPED_PRIVATE_KEY: "wrapped_private_key",
} as const;

export const MASK_SENTINEL = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
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

type CacheState = { entries: Map<string, string> | null; time: number };
const [getCacheState, setCacheState] = lazyRef<CacheState>(() => ({
  entries: null,
  time: 0,
}));

const isCacheValid = (): boolean => {
  const s = getCacheState();
  return s.entries !== null && nowMs() - s.time < SETTINGS_CACHE_TTL_MS;
};

registerCache(() => ({
  entries: getCacheState().entries?.size ?? 0,
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
  CONFIG_KEYS.LISTING_COLUMN_ORDER,
  CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
  CONFIG_KEYS.LAST_PRUNED_PAYMENTS,
  CONFIG_KEYS.LAST_PRUNED_SESSIONS,
  CONFIG_KEYS.LAST_PRUNED_SUMUP,
  CONFIG_KEYS.LAST_PRUNED_LOGINS,
  CONFIG_KEYS.LAST_PRUNED_TOKENS,
] as const;

/** Encrypted string config keys (decrypted during loadAll, default ""). */
const ENCRYPTED_KEYS = [
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  CONFIG_KEYS.WEBSITE_TITLE,
  CONFIG_KEYS.HOMEPAGE_TEXT,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.QUOTE_INTRO_TEXT,
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
  contact_form_enabled: boolean;
  quote_enabled: boolean;
  payment_provider: PaymentProviderType | null;
  payment_provider_setting: PaymentProviderSetting | null;
  booking_fee: string;
  square_sandbox: boolean;
  superuser_choice: SuperuserChoice;
  currency: string;
  timezone: string;
  phone_prefix: string;
};

/** Full settings snapshot type. */
export type SettingsData = SpecificFields & StringSettingFields;

/** Mutable snapshot of all settings. Populated by loadAll(). */
const data: SettingsData = {
  booking_fee: "0",
  contact_form_enabled: false,
  country: DEFAULT_COUNTRY,
  currency: "GBP",
  payment_provider: null,
  payment_provider_setting: null,
  phone_prefix: "+44",
  quote_enabled: false,
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

/** Read a snapshot value, checking test overrides first. */
const snap = <K extends keyof SettingsData>(key: K): SettingsData[K] => {
  const overrides = getTestOverrides();
  return key in overrides ? (overrides[key] as SettingsData[K]) : data[key];
};

// ---------------------------------------------------------------------------
// Raw DB operations (internal)
// ---------------------------------------------------------------------------

/** Read a raw string from the cache. Returns null if missing or cache not loaded. */
const getRawCached = (key: string): string | null =>
  getCacheState().entries?.get(key) ?? null;

/** Mutate the raw cache if it's currently loaded; no-op otherwise. */
const syncCache = (mutate: (entries: Map<string, string>) => void): void => {
  const { entries } = getCacheState();
  if (entries) mutate(entries);
};

/** Write a setting to the DB and update the raw cache in-place. */
const writeRaw = async (key: string, value: string): Promise<void> => {
  await getDb().execute({
    args: [key, value],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
  });
  syncCache((entries) => entries.set(key, value));
};

/** Delete a setting from the DB and remove it from the raw cache. */
const deleteRaw = async (key: string): Promise<void> => {
  await getDb().execute({
    args: [key],
    sql: "DELETE FROM settings WHERE key = ?",
  });
  syncCache((entries) => entries.delete(key));
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
  lastPrunedLogins: { key: CONFIG_KEYS.LAST_PRUNED_LOGINS },
  lastPrunedPayments: { key: CONFIG_KEYS.LAST_PRUNED_PAYMENTS },
  lastPrunedSessions: { key: CONFIG_KEYS.LAST_PRUNED_SESSIONS },
  lastPrunedSumup: { key: CONFIG_KEYS.LAST_PRUNED_SUMUP },
  lastPrunedTokens: { key: CONFIG_KEYS.LAST_PRUNED_TOKENS },
  latestScriptVersion: { key: CONFIG_KEYS.LATEST_SCRIPT_VERSION },
  latestScriptVersionName: { key: CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME },
  listingColumnOrder: { key: CONFIG_KEYS.LISTING_COLUMN_ORDER },
  // readOnly: key material is only written by setup/password flows
  publicKey: { key: CONFIG_KEYS.PUBLIC_KEY, readOnly: true },
  quoteIntroText: { key: CONFIG_KEYS.QUOTE_INTRO_TEXT },
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
// Snapshot builder — called by loadAll()
// ---------------------------------------------------------------------------

type CountryInfo = ReturnType<typeof getCountry>;
const applyCountryDerived = (info: CountryInfo): void => {
  data.currency = info.currency;
  data.timezone = info.timezone;
  data.phone_prefix = info.phonePrefix;
};

const buildSnapshot = async (raw: Map<string, string>): Promise<void> => {
  // Plaintext special fields
  const country = raw.get(CONFIG_KEYS.COUNTRY) || DEFAULT_COUNTRY;
  const info = getCountry(country);

  data.country = country;
  data.theme = raw.get(CONFIG_KEYS.THEME) === "dark" ? "dark" : "light";
  data.show_public_site = raw.get(CONFIG_KEYS.SHOW_PUBLIC_SITE) === "true";
  data.show_public_api = raw.get(CONFIG_KEYS.SHOW_PUBLIC_API) === "true";
  data.contact_form_enabled =
    raw.get(CONFIG_KEYS.CONTACT_FORM_ENABLED) === "true";
  data.quote_enabled = raw.get(CONFIG_KEYS.QUOTE_ENABLED) === "true";
  const rawProvider = raw.get(CONFIG_KEYS.PAYMENT_PROVIDER);
  data.payment_provider =
    rawProvider && isPaymentProvider(rawProvider) ? rawProvider : null;
  data.payment_provider_setting =
    rawProvider && isPaymentProviderSetting(rawProvider) ? rawProvider : null;
  data.booking_fee = raw.get(CONFIG_KEYS.BOOKING_FEE) ?? "0";
  data.square_sandbox = raw.get(CONFIG_KEYS.SQUARE_SANDBOX) === "true";

  // Plaintext string fields — config key IS the snapshot key
  for (const key of PLAINTEXT_KEYS) {
    setSnapshotField(key, raw.get(key) ?? "");
  }

  // Derived
  applyCountryDerived(info);

  // Encrypted — parallel decrypt
  const values = await Promise.all(
    ENCRYPTED_KEYS.map((key) => {
      const v = raw.get(key);
      return v ? decrypt(v) : "";
    }),
  );
  for (let i = 0; i < ENCRYPTED_KEYS.length; i++) {
    setSnapshotField(ENCRYPTED_KEYS[i]!, values[i]!);
  }
};

// ---------------------------------------------------------------------------
// loadAll / invalidateCache
// ---------------------------------------------------------------------------

/**
 * Load all settings from the DB and pre-decrypt encrypted values.
 * No-op when the raw cache is still valid.
 */
const loadAll = async (): Promise<void> => {
  if (isCacheValid()) return;
  const rows = await queryAll<Settings>("SELECT key, value FROM settings");
  const raw = new Map<string, string>();
  for (const row of rows) raw.set(row.key, row.value);
  setCacheState({ entries: raw, time: nowMs() });
  await buildSnapshot(raw);
};

/** Full invalidation — clears raw cache AND resets snapshot to defaults. */
const invalidateCache = (): void => {
  setCacheState(null);
  for (const key of Object.keys(defaults) as (keyof SettingsData)[]) {
    setSnapshotField(key, defaults[key]);
  }
};

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
  // Need the raw cache for this check
  if (!isCacheValid()) await loadAll();
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
  // Keep the in-memory snapshot in sync with the freshly-written rows so the
  // next request doesn't read stale defaults while the raw cache is still
  // valid (loadAll short-circuits for up to SETTINGS_CACHE_TTL_MS).
  setSnapshotField(CONFIG_KEYS.WRAPPED_PRIVATE_KEY, encryptedPrivateKey);
  setSnapshotField(CONFIG_KEYS.PUBLIC_KEY, publicKey);
  data.country = country;
  applyCountryDerived(getCountry(country));
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
  await getDb().execute({
    args: [encryptedNewHash, newWrappedDataKey, userId],
    sql: "UPDATE users SET password_hash = ?, wrapped_data_key = ? WHERE id = ?",
  });
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
  await getDb().execute({
    args: [CONFIG_KEYS.CURRENT_TASK],
    sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')",
  });
  // Atomic claim: only succeeds when no task is running
  const claim = await getDb().execute({
    args: [taskName, CONFIG_KEYS.CURRENT_TASK],
    sql: "UPDATE settings SET value = ? WHERE key = ? AND value = ''",
  });
  if (claim.rowsAffected === 0) {
    return {
      error: "Another task is already in progress",
      ok: false,
    };
  }
  const state = getCacheState();
  if (state.entries) state.entries.set(CONFIG_KEYS.CURRENT_TASK, taskName);
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
  get bookingFee(): string {
    return snap("booking_fee");
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

  // -----------------------------------------------------------------------
  // Sync reads — all populated by loadAll()
  // -----------------------------------------------------------------------

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
  invalidateCache,
  // --- Core ---
  loadAll,
  get paymentProvider(): PaymentProviderType | null {
    return snap("payment_provider");
  },
  get paymentProviderSetting(): PaymentProviderSetting | null {
    return snap("payment_provider_setting");
  },
  get phonePrefix(): string {
    return snap("phone_prefix");
  },

  get quoteEnabled(): boolean {
    return snap("quote_enabled");
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
    bookingFee: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.BOOKING_FEE, v);
      data.booking_fee = v || "0";
    },
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
    paymentProvider: async (v: PaymentProviderType): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, v);
      data.payment_provider = v;
      data.payment_provider_setting = v;
    },
    quoteEnabled: boolUpdate(CONFIG_KEYS.QUOTE_ENABLED, "quote_enabled"),
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
    theme: rawUpdate(CONFIG_KEYS.THEME, "theme") as (v: Theme) => Promise<void>,
  },
  updateUserPassword,
  withCurrentTask,
};

export const settings = withProperties(settingsBase, stringAccessors.getters);
