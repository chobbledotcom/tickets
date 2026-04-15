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
import { registerCache } from "#lib/cache-registry.ts";
import { DEFAULT_COUNTRY, getCountry } from "#lib/countries.ts";
import { decrypt, encrypt, encryptWithKey } from "#lib/crypto/encryption.ts";
import { hashPassword } from "#lib/crypto/hashing.ts";
import {
  deriveKEK,
  generateDataKey,
  generateKeyPair,
  unwrapKey,
  wrapKey,
} from "#lib/crypto/keys.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
import { deleteAllSessions } from "#lib/db/sessions.ts";
import { createUser, invalidateUsersCache } from "#lib/db/users.ts";
import { nowMs } from "#lib/now.ts";
import { DEFAULT_TIMEZONE } from "#lib/timezone.ts";
import type { PaymentProviderType, Settings, Theme } from "#lib/types.ts";
import { isPaymentProvider } from "#lib/types.ts";
import {
  createAppleWalletReadSettings,
  createAppleWalletUpdateSettings,
} from "#lib/wallets/apple-wallet-settings.ts";
import {
  createGoogleWalletReadSettings,
  createGoogleWalletUpdateSettings,
} from "#lib/wallets/google-wallet-settings.ts";

// ---------------------------------------------------------------------------
// Setting keys
// ---------------------------------------------------------------------------

export const CONFIG_KEYS = {
  COUNTRY: "country",
  SETUP_COMPLETE: "setup_complete",
  WRAPPED_PRIVATE_KEY: "wrapped_private_key",
  PUBLIC_KEY: "public_key",
  PAYMENT_PROVIDER: "payment_provider",
  STRIPE_SECRET_KEY: "stripe_secret_key",
  STRIPE_WEBHOOK_SECRET: "stripe_webhook_secret",
  STRIPE_WEBHOOK_ENDPOINT_ID: "stripe_webhook_endpoint_id",
  SQUARE_ACCESS_TOKEN: "square_access_token",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "square_webhook_signature_key",
  SQUARE_LOCATION_ID: "square_location_id",
  SQUARE_SANDBOX: "square_sandbox",
  EMBED_HOSTS: "embed_hosts",
  TERMS_AND_CONDITIONS: "terms_and_conditions",
  BUSINESS_EMAIL: "business_email",
  THEME: "theme",
  SHOW_PUBLIC_SITE: "show_public_site",
  WEBSITE_TITLE: "website_title",
  HOMEPAGE_TEXT: "homepage_text",
  CONTACT_PAGE_TEXT: "contact_page_text",
  HEADER_IMAGE_URL: "header_image_url",
  SHOW_PUBLIC_API: "show_public_api",
  EMAIL_PROVIDER: "email_provider",
  EMAIL_API_KEY: "email_api_key",
  EMAIL_FROM_ADDRESS: "email_from_address",
  EMAIL_TPL_CONFIRMATION_SUBJECT: "email_tpl_confirmation_subject",
  EMAIL_TPL_CONFIRMATION_HTML: "email_tpl_confirmation_html",
  EMAIL_TPL_CONFIRMATION_TEXT: "email_tpl_confirmation_text",
  EMAIL_TPL_ADMIN_SUBJECT: "email_tpl_admin_subject",
  EMAIL_TPL_ADMIN_HTML: "email_tpl_admin_html",
  EMAIL_TPL_ADMIN_TEXT: "email_tpl_admin_text",
  CUSTOM_DOMAIN: "custom_domain",
  CUSTOM_DOMAIN_LAST_VALIDATED: "custom_domain_last_validated",
  BOOKING_FEE: "booking_fee",
  APPLE_WALLET_PASS_TYPE_ID: "apple_wallet_pass_type_id",
  APPLE_WALLET_TEAM_ID: "apple_wallet_team_id",
  APPLE_WALLET_SIGNING_CERT: "apple_wallet_signing_cert",
  APPLE_WALLET_SIGNING_KEY: "apple_wallet_signing_key",
  APPLE_WALLET_WWDR_CERT: "apple_wallet_wwdr_cert",
  GOOGLE_WALLET_ISSUER_ID: "google_wallet_issuer_id",
  GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: "google_wallet_service_account_email",
  GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: "google_wallet_service_account_key",
  BUNNY_SUBDOMAIN: "bunny_subdomain",
  CURRENT_TASK: "current_task",
  LATEST_SCRIPT_VERSION: "latest_script_version",
  LATEST_SCRIPT_VERSION_NAME: "latest_script_version_name",
  EVENT_COLUMN_ORDER: "event_column_order",
  ATTENDEE_COLUMN_ORDER: "attendee_column_order",
  LAST_PRUNED_PAYMENTS: "last_pruned_payments",
  LAST_PRUNED_SESSIONS: "last_pruned_sessions",
  LAST_PRUNED_LOGINS: "last_pruned_logins",
} as const;

export const MASK_SENTINEL = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
export const isMaskSentinel = (value: string): boolean =>
  value === MASK_SENTINEL;

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
  name: "settings",
  entries: getCacheState().entries?.size ?? 0,
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
  "confirmation:subject": "email_tpl_confirmation_subject",
  "confirmation:html": "email_tpl_confirmation_html",
  "confirmation:text": "email_tpl_confirmation_text",
  "admin:subject": "email_tpl_admin_subject",
  "admin:html": "email_tpl_admin_html",
  "admin:text": "email_tpl_admin_text",
};

// ---------------------------------------------------------------------------
// String setting keys — plaintext and encrypted
// ---------------------------------------------------------------------------

/** Plaintext string config keys (stored unencrypted, default ""). */
const PLAINTEXT_KEYS = [
  CONFIG_KEYS.TERMS_AND_CONDITIONS,
  CONFIG_KEYS.EMAIL_PROVIDER,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.CURRENT_TASK,
  CONFIG_KEYS.PUBLIC_KEY,
  CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
  CONFIG_KEYS.SQUARE_LOCATION_ID,
  CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
  CONFIG_KEYS.LATEST_SCRIPT_VERSION,
  CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME,
  CONFIG_KEYS.EVENT_COLUMN_ORDER,
  CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
  CONFIG_KEYS.LAST_PRUNED_PAYMENTS,
  CONFIG_KEYS.LAST_PRUNED_SESSIONS,
  CONFIG_KEYS.LAST_PRUNED_LOGINS,
] as const;

/** Encrypted string config keys (decrypted during loadAll, default ""). */
const ENCRYPTED_KEYS = [
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  CONFIG_KEYS.WEBSITE_TITLE,
  CONFIG_KEYS.HOMEPAGE_TEXT,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.STRIPE_SECRET_KEY,
  CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
  CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
  CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
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
  payment_provider: PaymentProviderType | null;
  booking_fee: string;
  square_sandbox: boolean;
  currency: string;
  timezone: string;
  phone_prefix: string;
};

/** Full settings snapshot type. */
export type SettingsData = SpecificFields & StringSettingFields;

/** Mutable snapshot of all settings. Populated by loadAll(). */
const data: SettingsData = {
  country: DEFAULT_COUNTRY,
  theme: "light",
  show_public_site: false,
  show_public_api: false,
  payment_provider: null,
  booking_fee: "0",
  square_sandbox: false,
  currency: "GBP",
  timezone: DEFAULT_TIMEZONE,
  phone_prefix: "+44",
  ...stringSettingDefaults,
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

/** Write a setting to the DB and update the raw cache in-place. */
const writeRaw = async (key: string, value: string): Promise<void> => {
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    args: [key, value],
  });
  const state = getCacheState();
  if (state.entries) state.entries.set(key, value);
};

/** Delete a setting from the DB and remove it from the raw cache. */
const deleteRaw = async (key: string): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM settings WHERE key = ?",
    args: [key],
  });
  const state = getCacheState();
  if (state.entries) state.entries.delete(key);
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

/** Factory: write encrypted value + update snapshot. */
const encryptedUpdate =
  (key: StringSettingKey) =>
  async (v: string): Promise<void> => {
    await writeEncrypted(key, v);
    setSnapshotField(key, v);
  };

/** Factory: write-or-delete plaintext value + update snapshot. */
const plaintextUpdate =
  (key: StringSettingKey) =>
  async (v: string): Promise<void> => {
    await writeOrDelete(key, v);
    setSnapshotField(key, v);
  };

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
  const rawProvider = raw.get(CONFIG_KEYS.PAYMENT_PROVIDER);
  data.payment_provider =
    rawProvider && isPaymentProvider(rawProvider) ? rawProvider : null;
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
    sql: "UPDATE users SET password_hash = ?, wrapped_data_key = ? WHERE id = ?",
    args: [encryptedNewHash, newWrappedDataKey, userId],
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
    sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, '')",
    args: [CONFIG_KEYS.CURRENT_TASK],
  });
  // Atomic claim: only succeeds when no task is running
  const claim = await getDb().execute({
    sql: "UPDATE settings SET value = ? WHERE key = ? AND value = ''",
    args: [taskName, CONFIG_KEYS.CURRENT_TASK],
  });
  if (claim.rowsAffected === 0) {
    return {
      ok: false,
      error: "Another task is already in progress",
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

export const settings = {
  // --- Core ---
  loadAll,
  invalidateCache,
  withCurrentTask,

  /** Read a raw (possibly encrypted) value from the cache. */
  getCachedRaw: getRawCached,

  /** Write a raw value to the DB (low-level, prefer update.*). */
  setRaw: writeRaw,

  /** Set test overrides (survive invalidateCache, cleared by clearTestOverrides). */
  setForTest(overrides: Partial<SettingsData>): void {
    const current = getTestOverrides();
    for (const [k, v] of Object.entries(overrides)) {
      current[k] = v;
    }
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

  get country(): string {
    return snap("country");
  },
  get theme(): Theme {
    return snap("theme");
  },
  get showPublicSite(): boolean {
    return snap("show_public_site");
  },
  get showPublicApi(): boolean {
    return snap("show_public_api");
  },
  get paymentProvider(): PaymentProviderType | null {
    return snap("payment_provider");
  },
  get terms(): string {
    return snap("terms_and_conditions");
  },
  get bookingFee(): string {
    return snap("booking_fee");
  },
  get customDomain(): string {
    return snap("custom_domain");
  },
  get customDomainLastValidated(): string {
    return snap("custom_domain_last_validated");
  },
  get bunnySubdomain(): string {
    return snap("bunny_subdomain");
  },
  get currentTask(): string {
    return snap("current_task");
  },
  get publicKey(): string {
    return snap("public_key");
  },
  get wrappedPrivateKey(): string {
    return snap("wrapped_private_key");
  },
  get headerImageUrl(): string {
    return snap("header_image_url");
  },
  get websiteTitle(): string {
    return snap("website_title");
  },
  get homepageText(): string {
    return snap("homepage_text");
  },
  get contactPageText(): string {
    return snap("contact_page_text");
  },
  get businessEmail(): string {
    return snap("business_email");
  },
  get embedHosts(): string {
    return snap("embed_hosts");
  },
  get latestScriptVersion(): string {
    return snap("latest_script_version");
  },
  get latestScriptVersionName(): string {
    return snap("latest_script_version_name");
  },
  get eventColumnOrder(): string {
    return snap("event_column_order");
  },
  get attendeeColumnOrder(): string {
    return snap("attendee_column_order");
  },
  get lastPrunedPayments(): string {
    return snap("last_pruned_payments");
  },
  get lastPrunedSessions(): string {
    return snap("last_pruned_sessions");
  },
  get lastPrunedLogins(): string {
    return snap("last_pruned_logins");
  },

  // Derived from country
  get currency(): string {
    return snap("currency");
  },
  get timezone(): string {
    return snap("timezone");
  },
  get phonePrefix(): string {
    return snap("phone_prefix");
  },

  // --- Stripe ---
  stripe: {
    get secretKey(): string {
      return snap("stripe_secret_key");
    },
    get hasKey(): boolean {
      return snap("stripe_secret_key") !== "";
    },
    get keyMode(): "test" | "live" | null {
      const k = snap("stripe_secret_key");
      if (!k) return null;
      if (k.startsWith("sk_test_")) return "test";
      if (k.startsWith("sk_live_")) return "live";
      return null;
    },
    get webhookSecret(): string {
      return snap("stripe_webhook_secret");
    },
    get webhookEndpointId(): string {
      return snap("stripe_webhook_endpoint_id");
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
    get webhookSignatureKey(): string {
      return snap("square_webhook_signature_key");
    },
    get locationId(): string {
      return snap("square_location_id");
    },
    get sandbox(): boolean {
      return snap("square_sandbox");
    },
  },

  // --- Email ---
  email: {
    get provider(): string {
      return snap("email_provider");
    },
    get apiKey(): string {
      return snap("email_api_key");
    },
    get hasApiKey(): boolean {
      return snap("email_api_key") !== "";
    },
    get fromAddress(): string {
      return snap("email_from_address");
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
        subject: this.template(type, "subject"),
        html: this.template(type, "html"),
        text: this.template(type, "text"),
      };
    },
  },

  // --- Apple Wallet ---
  appleWallet: createAppleWalletReadSettings(snap as (k: string) => string),

  // --- Google Wallet ---
  googleWallet: createGoogleWalletReadSettings(snap as (k: string) => string),

  // --- Setup & auth ---
  setup: {
    isComplete: isSetupComplete,
    complete: completeSetup,
    clearCache: clearSetupCompleteCache,
  },
  updateUserPassword,

  // -----------------------------------------------------------------------
  // Async writes — settings.update.*
  // -----------------------------------------------------------------------
  update: {
    country: async (v: string): Promise<void> => {
      await writeRaw(CONFIG_KEYS.COUNTRY, v);
      data.country = v;
      applyCountryDerived(getCountry(v));
    },
    theme: async (v: Theme): Promise<void> => {
      await writeRaw(CONFIG_KEYS.THEME, v);
      data.theme = v;
    },
    showPublicSite: async (v: boolean): Promise<void> => {
      await writeRaw(CONFIG_KEYS.SHOW_PUBLIC_SITE, v ? "true" : "false");
      data.show_public_site = v;
    },
    showPublicApi: async (v: boolean): Promise<void> => {
      await writeRaw(CONFIG_KEYS.SHOW_PUBLIC_API, v ? "true" : "false");
      data.show_public_api = v;
    },
    paymentProvider: async (v: PaymentProviderType): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, v);
      data.payment_provider = v;
    },
    clearPaymentProvider: async (): Promise<void> => {
      await deleteRaw(CONFIG_KEYS.PAYMENT_PROVIDER);
      data.payment_provider = null;
    },
    terms: plaintextUpdate(CONFIG_KEYS.TERMS_AND_CONDITIONS),
    bookingFee: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.BOOKING_FEE, v);
      data.booking_fee = v || "0";
    },
    customDomain: plaintextUpdate(CONFIG_KEYS.CUSTOM_DOMAIN),
    customDomainLastValidated: async (): Promise<void> => {
      const ts = new Date().toISOString();
      await writeRaw(CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED, ts);
      data.custom_domain_last_validated = ts;
    },
    bunnySubdomain: plaintextUpdate(CONFIG_KEYS.BUNNY_SUBDOMAIN),
    currentTask: plaintextUpdate(CONFIG_KEYS.CURRENT_TASK),
    headerImageUrl: encryptedUpdate(CONFIG_KEYS.HEADER_IMAGE_URL),
    websiteTitle: encryptedUpdate(CONFIG_KEYS.WEBSITE_TITLE),
    homepageText: encryptedUpdate(CONFIG_KEYS.HOMEPAGE_TEXT),
    contactPageText: encryptedUpdate(CONFIG_KEYS.CONTACT_PAGE_TEXT),
    businessEmail: encryptedUpdate(CONFIG_KEYS.BUSINESS_EMAIL),
    embedHosts: encryptedUpdate(CONFIG_KEYS.EMBED_HOSTS),
    latestScriptVersion: plaintextUpdate(CONFIG_KEYS.LATEST_SCRIPT_VERSION),
    latestScriptVersionName: plaintextUpdate(
      CONFIG_KEYS.LATEST_SCRIPT_VERSION_NAME,
    ),
    eventColumnOrder: plaintextUpdate(CONFIG_KEYS.EVENT_COLUMN_ORDER),
    attendeeColumnOrder: plaintextUpdate(CONFIG_KEYS.ATTENDEE_COLUMN_ORDER),
    lastPrunedPayments: plaintextUpdate(CONFIG_KEYS.LAST_PRUNED_PAYMENTS),
    lastPrunedSessions: plaintextUpdate(CONFIG_KEYS.LAST_PRUNED_SESSIONS),
    lastPrunedLogins: plaintextUpdate(CONFIG_KEYS.LAST_PRUNED_LOGINS),
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

    // --- Square writes ---
    square: {
      accessToken: encryptedUpdate(CONFIG_KEYS.SQUARE_ACCESS_TOKEN),
      webhookSignatureKey: encryptedUpdate(
        CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
      ),
      locationId: async (v: string): Promise<void> => {
        await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, v);
        data.square_location_id = v;
      },
      sandbox: async (v: boolean): Promise<void> => {
        await writeRaw(CONFIG_KEYS.SQUARE_SANDBOX, v ? "true" : "false");
        data.square_sandbox = v;
      },
    },

    // --- Email writes ---
    email: {
      provider: plaintextUpdate(CONFIG_KEYS.EMAIL_PROVIDER),
      apiKey: encryptedUpdate(CONFIG_KEYS.EMAIL_API_KEY),
      fromAddress: encryptedUpdate(CONFIG_KEYS.EMAIL_FROM_ADDRESS),
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

    // --- Apple Wallet writes ---
    appleWallet: createAppleWalletUpdateSettings(
      encryptedUpdate as (k: string) => (v: string) => Promise<void>,
    ),

    // --- Google Wallet writes ---
    googleWallet: createGoogleWalletUpdateSettings(
      encryptedUpdate as (k: string) => (v: string) => Promise<void>,
    ),
  },
};
