/**
 * Settings — sync reads, async writes.
 *
 * Call `settings.loadAll()` once per request to populate the snapshot.
 * After that, every setting is a plain sync property:
 *
 *   settings.theme            // "light"
 *   settings.headerImageUrl   // string | null
 *   settings.stripe.secretKey // string | null
 *
 * Writes go through `settings.update.*`:
 *
 *   await settings.update.theme("dark");
 *   await settings.update.headerImageUrl(url);
 */

import { lazyRef } from "#fp";
import type { SigningCredentials } from "#lib/apple-wallet.ts";
import { registerCache } from "#lib/cache-registry.ts";
import { DEFAULT_COUNTRY, getCountry } from "#lib/countries.ts";
import {
  decrypt,
  deriveKEK,
  encrypt,
  encryptWithKey,
  generateDataKey,
  generateKeyPair,
  hashPassword,
  unwrapKey,
  wrapKey,
} from "#lib/crypto.ts";
import { getDb, queryAll } from "#lib/db/client.ts";
import { deleteAllSessions } from "#lib/db/sessions.ts";
import { createUser, invalidateUsersCache } from "#lib/db/users.ts";
import { getEnv } from "#lib/env.ts";
import type { GoogleWalletCredentials } from "#lib/google-wallet.ts";
import { nowMs } from "#lib/now.ts";
import { DEFAULT_TIMEZONE } from "#lib/timezone.ts";
import type { PaymentProviderType, Settings, Theme } from "#lib/types.ts";

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
  ATTENDEE_BLOB_MIGRATED: "attendee_blob_migrated",
} as const;

export const MASK_SENTINEL = "••••••••";
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

const TEMPLATE_SNAPSHOT_KEYS: Record<string, keyof typeof data> = {
  "confirmation:subject": "emailTplConfirmationSubject",
  "confirmation:html": "emailTplConfirmationHtml",
  "confirmation:text": "emailTplConfirmationText",
  "admin:subject": "emailTplAdminSubject",
  "admin:html": "emailTplAdminHtml",
  "admin:text": "emailTplAdminText",
};

const TEMPLATE_CONFIG_KEYS: Record<string, string> = {
  "confirmation:subject": CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT,
  "confirmation:html": CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML,
  "confirmation:text": CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT,
  "admin:subject": CONFIG_KEYS.EMAIL_TPL_ADMIN_SUBJECT,
  "admin:html": CONFIG_KEYS.EMAIL_TPL_ADMIN_HTML,
  "admin:text": CONFIG_KEYS.EMAIL_TPL_ADMIN_TEXT,
};

/** Mutable snapshot of all settings. Populated by loadAll(). */
const data = {
  // --- Plaintext ---
  country: DEFAULT_COUNTRY,
  theme: "light" as Theme,
  showPublicSite: false,
  showPublicApi: false,
  paymentProvider: null as PaymentProviderType | null,
  terms: null as string | null,
  emailProvider: null as string | null,
  bookingFee: "0",
  customDomain: null as string | null,
  customDomainLastValidated: null as string | null,
  publicKey: null as string | null,
  wrappedPrivateKey: null as string | null,
  squareLocationId: null as string | null,
  squareSandbox: false,
  stripeWebhookEndpointId: null as string | null,
  appleWalletPassTypeId: null as string | null,
  appleWalletTeamId: null as string | null,
  googleWalletIssuerId: null as string | null,
  googleWalletServiceAccountEmail: null as string | null,
  attendeeBlobMigrated: false,

  // --- Derived from country ---
  currency: "GBP",
  timezone: DEFAULT_TIMEZONE,
  phonePrefix: "+44",

  // --- Encrypted (pre-decrypted by loadAll) ---
  businessEmail: null as string | null,
  headerImageUrl: null as string | null,
  websiteTitle: null as string | null,
  homepageText: null as string | null,
  contactPageText: null as string | null,
  stripeSecretKey: null as string | null,
  stripeWebhookSecret: null as string | null,
  squareAccessToken: null as string | null,
  squareWebhookSignatureKey: null as string | null,
  embedHosts: null as string | null,
  emailApiKey: null as string | null,
  emailFromAddress: null as string | null,
  emailTplConfirmationSubject: null as string | null,
  emailTplConfirmationHtml: null as string | null,
  emailTplConfirmationText: null as string | null,
  emailTplAdminSubject: null as string | null,
  emailTplAdminHtml: null as string | null,
  emailTplAdminText: null as string | null,
  appleWalletSigningCert: null as string | null,
  appleWalletSigningKey: null as string | null,
  appleWalletWwdrCert: null as string | null,
  googleWalletServiceAccountKey: null as string | null,
};

type SettingsData = typeof data;

const defaults: Readonly<SettingsData> = { ...data };

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

// ---------------------------------------------------------------------------
// Snapshot builder — called by loadAll()
// ---------------------------------------------------------------------------

/** Mapping: CONFIG_KEY → snapshot field for encrypted values. */
const ENCRYPTED_FIELDS: [string, keyof SettingsData][] = [
  [CONFIG_KEYS.BUSINESS_EMAIL, "businessEmail"],
  [CONFIG_KEYS.HEADER_IMAGE_URL, "headerImageUrl"],
  [CONFIG_KEYS.WEBSITE_TITLE, "websiteTitle"],
  [CONFIG_KEYS.HOMEPAGE_TEXT, "homepageText"],
  [CONFIG_KEYS.CONTACT_PAGE_TEXT, "contactPageText"],
  [CONFIG_KEYS.STRIPE_SECRET_KEY, "stripeSecretKey"],
  [CONFIG_KEYS.STRIPE_WEBHOOK_SECRET, "stripeWebhookSecret"],
  [CONFIG_KEYS.SQUARE_ACCESS_TOKEN, "squareAccessToken"],
  [CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY, "squareWebhookSignatureKey"],
  [CONFIG_KEYS.EMBED_HOSTS, "embedHosts"],
  [CONFIG_KEYS.EMAIL_API_KEY, "emailApiKey"],
  [CONFIG_KEYS.EMAIL_FROM_ADDRESS, "emailFromAddress"],
  [CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT, "emailTplConfirmationSubject"],
  [CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML, "emailTplConfirmationHtml"],
  [CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT, "emailTplConfirmationText"],
  [CONFIG_KEYS.EMAIL_TPL_ADMIN_SUBJECT, "emailTplAdminSubject"],
  [CONFIG_KEYS.EMAIL_TPL_ADMIN_HTML, "emailTplAdminHtml"],
  [CONFIG_KEYS.EMAIL_TPL_ADMIN_TEXT, "emailTplAdminText"],
  [CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT, "appleWalletSigningCert"],
  [CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY, "appleWalletSigningKey"],
  [CONFIG_KEYS.APPLE_WALLET_WWDR_CERT, "appleWalletWwdrCert"],
  [
    CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
    "googleWalletServiceAccountKey",
  ],
];

type CountryInfo = ReturnType<typeof getCountry>;
const applyCountryDerived = (info: CountryInfo): void => {
  data.currency = info.currency;
  data.timezone = info.timezone;
  data.phonePrefix = info.phonePrefix;
};

const buildSnapshot = async (raw: Map<string, string>): Promise<void> => {
  // Plaintext fields
  const country = raw.get(CONFIG_KEYS.COUNTRY) || DEFAULT_COUNTRY;
  const info = getCountry(country);

  data.country = country;
  data.theme = raw.get(CONFIG_KEYS.THEME) === "dark" ? "dark" : "light";
  data.showPublicSite = raw.get(CONFIG_KEYS.SHOW_PUBLIC_SITE) === "true";
  data.showPublicApi = raw.get(CONFIG_KEYS.SHOW_PUBLIC_API) === "true";
  data.paymentProvider =
    (raw.get(CONFIG_KEYS.PAYMENT_PROVIDER) as PaymentProviderType) ?? null;
  data.terms = raw.get(CONFIG_KEYS.TERMS_AND_CONDITIONS) ?? null;
  data.emailProvider = raw.get(CONFIG_KEYS.EMAIL_PROVIDER) ?? null;
  data.bookingFee = raw.get(CONFIG_KEYS.BOOKING_FEE) ?? "0";
  data.customDomain = raw.get(CONFIG_KEYS.CUSTOM_DOMAIN) ?? null;
  data.customDomainLastValidated =
    raw.get(CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED) ?? null;
  data.publicKey = raw.get(CONFIG_KEYS.PUBLIC_KEY) ?? null;
  data.wrappedPrivateKey = raw.get(CONFIG_KEYS.WRAPPED_PRIVATE_KEY) ?? null;
  data.squareLocationId = raw.get(CONFIG_KEYS.SQUARE_LOCATION_ID) ?? null;
  data.squareSandbox = raw.get(CONFIG_KEYS.SQUARE_SANDBOX) === "true";
  data.stripeWebhookEndpointId =
    raw.get(CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID) ?? null;
  data.appleWalletPassTypeId =
    raw.get(CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID) ?? null;
  data.appleWalletTeamId = raw.get(CONFIG_KEYS.APPLE_WALLET_TEAM_ID) ?? null;
  data.googleWalletIssuerId =
    raw.get(CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID) ?? null;
  data.googleWalletServiceAccountEmail =
    raw.get(CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL) ?? null;
  const m = raw.get(CONFIG_KEYS.ATTENDEE_BLOB_MIGRATED);
  data.attendeeBlobMigrated = m !== undefined && m !== "" && m !== null;

  // Derived
  applyCountryDerived(info);

  // Encrypted — parallel decrypt
  const values = await Promise.all(
    ENCRYPTED_FIELDS.map(([key]) => {
      const v = raw.get(key);
      return v ? decrypt(v) : null;
    }),
  );
  for (let i = 0; i < ENCRYPTED_FIELDS.length; i++) {
    const field = ENCRYPTED_FIELDS[i]!;
    (data as Record<string, unknown>)[field[1]] = values[i] ?? null;
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
  for (const key of Object.keys(defaults)) {
    (data as Record<string, unknown>)[key] = (
      defaults as Record<string, unknown>
    )[key];
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
// Apple Wallet host config (env-var based, separate from DB settings)
// ---------------------------------------------------------------------------

const toCredentials = (
  passTypeId: string | null | undefined,
  teamId: string | null | undefined,
  signingCert: string | null | undefined,
  signingKey: string | null | undefined,
  wwdrCert: string | null | undefined,
): SigningCredentials | null =>
  passTypeId && teamId && signingCert && signingKey && wwdrCert
    ? { passTypeId, teamId, signingCert, signingKey, wwdrCert }
    : null;

const getHostAppleWalletConfigFromEnv = (): SigningCredentials | null =>
  toCredentials(
    getEnv("APPLE_WALLET_PASS_TYPE_ID"),
    getEnv("APPLE_WALLET_TEAM_ID"),
    getEnv("APPLE_WALLET_SIGNING_CERT"),
    getEnv("APPLE_WALLET_SIGNING_KEY"),
    getEnv("APPLE_WALLET_WWDR_CERT"),
  );

const [getHostWalletOverride, setHostWalletOverride] = lazyRef<
  SigningCredentials | null | undefined
>(() => undefined);

const getHostAppleWalletConfig = (): SigningCredentials | null => {
  const override = getHostWalletOverride();
  return override !== undefined ? override : getHostAppleWalletConfigFromEnv();
};

// ---------------------------------------------------------------------------
// Google Wallet host config
// ---------------------------------------------------------------------------

const toGoogleCredentials = (
  issuerId: string | null | undefined,
  serviceAccountEmail: string | null | undefined,
  serviceAccountKey: string | null | undefined,
): GoogleWalletCredentials | null =>
  issuerId && serviceAccountEmail && serviceAccountKey
    ? { issuerId, serviceAccountEmail, serviceAccountKey }
    : null;

const getHostGoogleWalletConfig = (): GoogleWalletCredentials | null =>
  toGoogleCredentials(
    getEnv("GOOGLE_WALLET_ISSUER_ID"),
    getEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL"),
    getEnv("GOOGLE_WALLET_SERVICE_ACCOUNT_KEY"),
  );

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_TERMS_LENGTH = 10_240;
export const MAX_WEBSITE_TITLE_LENGTH = 128;
export const MAX_PAGE_TEXT_LENGTH = 2048;
export const MAX_EMAIL_TEMPLATE_LENGTH = 51_200;

// ---------------------------------------------------------------------------
// The settings namespace
// ---------------------------------------------------------------------------

export const settings = {
  // --- Core ---
  loadAll,
  invalidateCache,

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
    return snap("showPublicSite");
  },
  get showPublicApi(): boolean {
    return snap("showPublicApi");
  },
  get paymentProvider(): PaymentProviderType | null {
    return snap("paymentProvider");
  },
  get terms(): string | null {
    return snap("terms");
  },
  get bookingFee(): string {
    return snap("bookingFee");
  },
  get customDomain(): string | null {
    return snap("customDomain");
  },
  get customDomainLastValidated(): string | null {
    return snap("customDomainLastValidated");
  },
  get publicKey(): string | null {
    return snap("publicKey");
  },
  get wrappedPrivateKey(): string | null {
    return snap("wrappedPrivateKey");
  },
  get headerImageUrl(): string | null {
    return snap("headerImageUrl");
  },
  get websiteTitle(): string | null {
    return snap("websiteTitle");
  },
  get homepageText(): string | null {
    return snap("homepageText");
  },
  get contactPageText(): string | null {
    return snap("contactPageText");
  },
  get businessEmail(): string | null {
    return snap("businessEmail");
  },
  get embedHosts(): string | null {
    return snap("embedHosts");
  },
  get attendeeBlobMigrated(): boolean {
    return snap("attendeeBlobMigrated");
  },

  // Derived from country
  get currency(): string {
    return snap("currency");
  },
  get timezone(): string {
    return snap("timezone");
  },
  get phonePrefix(): string {
    return snap("phonePrefix");
  },

  // --- Stripe ---
  stripe: {
    get secretKey(): string | null {
      return snap("stripeSecretKey");
    },
    get hasKey(): boolean {
      return snap("stripeSecretKey") !== null;
    },
    get keyMode(): "test" | "live" | null {
      const k = snap("stripeSecretKey");
      if (!k) return null;
      if (k.startsWith("sk_test_")) return "test";
      if (k.startsWith("sk_live_")) return "live";
      return null;
    },
    get webhookSecret(): string | null {
      return snap("stripeWebhookSecret");
    },
    get webhookEndpointId(): string | null {
      return snap("stripeWebhookEndpointId");
    },
  },

  // --- Square ---
  square: {
    get accessToken(): string | null {
      return snap("squareAccessToken");
    },
    get hasToken(): boolean {
      return snap("squareAccessToken") !== null;
    },
    get webhookSignatureKey(): string | null {
      return snap("squareWebhookSignatureKey");
    },
    get locationId(): string | null {
      return snap("squareLocationId");
    },
    get sandbox(): boolean {
      return snap("squareSandbox");
    },
  },

  // --- Email ---
  email: {
    get provider(): string | null {
      return snap("emailProvider");
    },
    get apiKey(): string | null {
      return snap("emailApiKey");
    },
    get hasApiKey(): boolean {
      return snap("emailApiKey") !== null;
    },
    get fromAddress(): string | null {
      return snap("emailFromAddress");
    },
    template(
      type: EmailTemplateType,
      format: EmailTemplateFormat,
    ): string | null {
      return snap(
        TEMPLATE_SNAPSHOT_KEYS[`${type}:${format}`] as keyof SettingsData,
      ) as string | null;
    },
    templateSet(type: EmailTemplateType): {
      subject: string | null;
      html: string | null;
      text: string | null;
    } {
      return {
        subject: this.template(type, "subject"),
        html: this.template(type, "html"),
        text: this.template(type, "text"),
      };
    },
  },

  // --- Apple Wallet ---
  appleWallet: {
    get passTypeId(): string | null {
      return snap("appleWalletPassTypeId");
    },
    get teamId(): string | null {
      return snap("appleWalletTeamId");
    },
    get signingCert(): string | null {
      return snap("appleWalletSigningCert");
    },
    get signingKey(): string | null {
      return snap("appleWalletSigningKey");
    },
    get wwdrCert(): string | null {
      return snap("appleWalletWwdrCert");
    },
    get hasDbConfig(): boolean {
      return (
        this.passTypeId !== null &&
        this.teamId !== null &&
        this.signingCert !== null &&
        this.signingKey !== null &&
        this.wwdrCert !== null
      );
    },
    get dbConfig(): SigningCredentials | null {
      return toCredentials(
        this.passTypeId,
        this.teamId,
        this.signingCert,
        this.signingKey,
        this.wwdrCert,
      );
    },
    get hostConfig(): SigningCredentials | null {
      return getHostAppleWalletConfig();
    },
    get config(): SigningCredentials | null {
      return this.dbConfig ?? this.hostConfig;
    },
    get hasConfig(): boolean {
      return this.config !== null;
    },
    setHostConfigForTest: (c: SigningCredentials | null): void =>
      setHostWalletOverride(c),
    resetHostConfig: (): void => setHostWalletOverride(undefined),
  },

  // --- Google Wallet ---
  googleWallet: {
    get issuerId(): string | null {
      return snap("googleWalletIssuerId");
    },
    get serviceAccountEmail(): string | null {
      return snap("googleWalletServiceAccountEmail");
    },
    get serviceAccountKey(): string | null {
      return snap("googleWalletServiceAccountKey");
    },
    get hasDbConfig(): boolean {
      const { issuerId, serviceAccountEmail, serviceAccountKey } = this;
      return (
        issuerId !== null &&
        serviceAccountEmail !== null &&
        serviceAccountKey !== null
      );
    },
    get dbConfig(): GoogleWalletCredentials | null {
      return toGoogleCredentials(
        this.issuerId,
        this.serviceAccountEmail,
        this.serviceAccountKey,
      );
    },
    get hostConfig(): GoogleWalletCredentials | null {
      return getHostGoogleWalletConfig();
    },
    get config(): GoogleWalletCredentials | null {
      return this.dbConfig ?? getHostGoogleWalletConfig();
    },
    get hasConfig(): boolean {
      return this.config !== null;
    },
  },

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
      data.showPublicSite = v;
    },
    showPublicApi: async (v: boolean): Promise<void> => {
      await writeRaw(CONFIG_KEYS.SHOW_PUBLIC_API, v ? "true" : "false");
      data.showPublicApi = v;
    },
    paymentProvider: async (v: PaymentProviderType): Promise<void> => {
      await writeRaw(CONFIG_KEYS.PAYMENT_PROVIDER, v);
      data.paymentProvider = v;
    },
    clearPaymentProvider: async (): Promise<void> => {
      await deleteRaw(CONFIG_KEYS.PAYMENT_PROVIDER);
      data.paymentProvider = null;
    },
    terms: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.TERMS_AND_CONDITIONS, v);
      data.terms = v || null;
    },
    bookingFee: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.BOOKING_FEE, v);
      data.bookingFee = v || "0";
    },
    customDomain: async (v: string): Promise<void> => {
      await writeOrDelete(CONFIG_KEYS.CUSTOM_DOMAIN, v);
      data.customDomain = v || null;
    },
    customDomainLastValidated: async (): Promise<void> => {
      const ts = new Date().toISOString();
      await writeRaw(CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED, ts);
      data.customDomainLastValidated = ts;
    },
    headerImageUrl: async (v: string): Promise<void> => {
      await writeEncrypted(CONFIG_KEYS.HEADER_IMAGE_URL, v);
      data.headerImageUrl = v || null;
    },
    websiteTitle: async (v: string): Promise<void> => {
      await writeEncrypted(CONFIG_KEYS.WEBSITE_TITLE, v);
      data.websiteTitle = v || null;
    },
    homepageText: async (v: string): Promise<void> => {
      await writeEncrypted(CONFIG_KEYS.HOMEPAGE_TEXT, v);
      data.homepageText = v || null;
    },
    contactPageText: async (v: string): Promise<void> => {
      await writeEncrypted(CONFIG_KEYS.CONTACT_PAGE_TEXT, v);
      data.contactPageText = v || null;
    },
    businessEmail: async (v: string): Promise<void> => {
      await writeEncrypted(CONFIG_KEYS.BUSINESS_EMAIL, v);
      data.businessEmail = v || null;
    },
    embedHosts: async (v: string): Promise<void> => {
      if (v === "") {
        await writeOrDelete(CONFIG_KEYS.EMBED_HOSTS, "");
        data.embedHosts = null;
        return;
      }
      await writeRaw(CONFIG_KEYS.EMBED_HOSTS, await encrypt(v));
      data.embedHosts = v;
    },
    attendeeBlobMigrated: async (): Promise<void> => {
      await writeRaw(
        CONFIG_KEYS.ATTENDEE_BLOB_MIGRATED,
        new Date().toISOString(),
      );
      data.attendeeBlobMigrated = true;
    },

    // --- Stripe writes ---
    stripe: {
      secretKey: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.STRIPE_SECRET_KEY, v);
        data.stripeSecretKey = v || null;
      },
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
        data.stripeWebhookSecret = config.secret;
        data.stripeWebhookEndpointId = config.endpointId;
      },
    },

    // --- Square writes ---
    square: {
      accessToken: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.SQUARE_ACCESS_TOKEN, v);
        data.squareAccessToken = v || null;
      },
      webhookSignatureKey: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY, v);
        data.squareWebhookSignatureKey = v || null;
      },
      locationId: async (v: string): Promise<void> => {
        await writeRaw(CONFIG_KEYS.SQUARE_LOCATION_ID, v);
        data.squareLocationId = v || null;
      },
      sandbox: async (v: boolean): Promise<void> => {
        await writeRaw(CONFIG_KEYS.SQUARE_SANDBOX, v ? "true" : "false");
        data.squareSandbox = v;
      },
    },

    // --- Email writes ---
    email: {
      provider: async (v: string): Promise<void> => {
        await writeOrDelete(CONFIG_KEYS.EMAIL_PROVIDER, v);
        data.emailProvider = v || null;
      },
      apiKey: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.EMAIL_API_KEY, v);
        data.emailApiKey = v || null;
      },
      fromAddress: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.EMAIL_FROM_ADDRESS, v);
        data.emailFromAddress = v || null;
      },
      template: async (
        type: EmailTemplateType,
        format: EmailTemplateFormat,
        content: string,
      ): Promise<void> => {
        const k = `${type}:${format}`;
        await writeEncrypted(TEMPLATE_CONFIG_KEYS[k]!, content);
        (data as Record<string, unknown>)[TEMPLATE_SNAPSHOT_KEYS[k]!] =
          content || null;
      },
    },

    // --- Apple Wallet writes ---
    appleWallet: {
      passTypeId: async (v: string): Promise<void> => {
        await writeOrDelete(CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID, v);
        data.appleWalletPassTypeId = v || null;
      },
      teamId: async (v: string): Promise<void> => {
        await writeOrDelete(CONFIG_KEYS.APPLE_WALLET_TEAM_ID, v);
        data.appleWalletTeamId = v || null;
      },
      signingCert: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT, v);
        data.appleWalletSigningCert = v || null;
      },
      signingKey: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY, v);
        data.appleWalletSigningKey = v || null;
      },
      wwdrCert: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.APPLE_WALLET_WWDR_CERT, v);
        data.appleWalletWwdrCert = v || null;
      },
    },

    // --- Google Wallet writes ---
    googleWallet: {
      issuerId: async (v: string): Promise<void> => {
        await writeOrDelete(CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID, v);
        data.googleWalletIssuerId = v || null;
      },
      serviceAccountEmail: async (v: string): Promise<void> => {
        await writeOrDelete(CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL, v);
        data.googleWalletServiceAccountEmail = v || null;
      },
      serviceAccountKey: async (v: string): Promise<void> => {
        await writeEncrypted(CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY, v);
        data.googleWalletServiceAccountKey = v || null;
      },
    },
  },
};
