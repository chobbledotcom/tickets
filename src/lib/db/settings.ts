/**
 * Settings table operations
 */

import { lazyRef } from "#fp";
import { registerCache } from "#lib/cache-registry.ts";
import { DEFAULT_TIMEZONE } from "#lib/timezone.ts";
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
import { nowMs } from "#lib/now.ts";
import { deleteAllSessions } from "#lib/db/sessions.ts";
import { createUser, invalidateUsersCache } from "#lib/db/users.ts";
import type { Settings } from "#lib/types.ts";

/**
 * Setting keys for configuration
 */
export const CONFIG_KEYS = {
  CURRENCY_CODE: "currency_code",
  SETUP_COMPLETE: "setup_complete",
  // Encryption key hierarchy
  WRAPPED_PRIVATE_KEY: "wrapped_private_key",
  PUBLIC_KEY: "public_key",
  // Payment provider selection
  PAYMENT_PROVIDER: "payment_provider",
  // Stripe configuration (encrypted)
  STRIPE_SECRET_KEY: "stripe_secret_key",
  STRIPE_WEBHOOK_SECRET: "stripe_webhook_secret",
  STRIPE_WEBHOOK_ENDPOINT_ID: "stripe_webhook_endpoint_id",
  // Square configuration (encrypted)
  SQUARE_ACCESS_TOKEN: "square_access_token",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "square_webhook_signature_key",
  SQUARE_LOCATION_ID: "square_location_id",
  SQUARE_SANDBOX: "square_sandbox",
  // Embed host restrictions (encrypted)
  EMBED_HOSTS: "embed_hosts",
  // Terms and conditions (plaintext - displayed publicly)
  TERMS_AND_CONDITIONS: "terms_and_conditions",
  // Timezone (IANA timezone identifier, plaintext)
  TIMEZONE: "timezone",
  // Business email (encrypted)
  BUSINESS_EMAIL: "business_email",
  // Theme setting (plaintext - light or dark)
  THEME: "theme",
  // Show public site (plaintext - "true" or "false")
  SHOW_PUBLIC_SITE: "show_public_site",
  // Website title (encrypted - shown on public site)
  WEBSITE_TITLE: "website_title",
  // Homepage text (encrypted - shown on public site homepage)
  HOMEPAGE_TEXT: "homepage_text",
  // Contact page text (encrypted - shown on public site contact page)
  CONTACT_PAGE_TEXT: "contact_page_text",
  // Phone prefix (plaintext - country calling code, e.g. "44")
  PHONE_PREFIX: "phone_prefix",
  // Header image (encrypted - Bunny CDN filename)
  HEADER_IMAGE_URL: "header_image_url",
  // Show public API (plaintext - "true" or "false")
  SHOW_PUBLIC_API: "show_public_api",
  // Email provider (plaintext - "resend" | "postmark" | "sendgrid" | "")
  EMAIL_PROVIDER: "email_provider",
  // Email API key (encrypted)
  EMAIL_API_KEY: "email_api_key",
  // Email from address (encrypted - verified sender address)
  EMAIL_FROM_ADDRESS: "email_from_address",
  // Custom email templates (encrypted - may contain PII in Liquid syntax)
  EMAIL_TPL_CONFIRMATION_SUBJECT: "email_tpl_confirmation_subject",
  EMAIL_TPL_CONFIRMATION_HTML: "email_tpl_confirmation_html",
  EMAIL_TPL_CONFIRMATION_TEXT: "email_tpl_confirmation_text",
  EMAIL_TPL_ADMIN_SUBJECT: "email_tpl_admin_subject",
  EMAIL_TPL_ADMIN_HTML: "email_tpl_admin_html",
  EMAIL_TPL_ADMIN_TEXT: "email_tpl_admin_text",
  // Custom domain (plaintext - user-configured custom domain for Bunny CDN pull zone)
  CUSTOM_DOMAIN: "custom_domain",
  // Custom domain last validated timestamp (plaintext - ISO 8601 UTC)
  CUSTOM_DOMAIN_LAST_VALIDATED: "custom_domain_last_validated",
} as const;

/**
 * Sentinel value rendered in password fields for configured secrets.
 * The actual secret is never sent to the browser — only this placeholder.
 * On form submission, if the value equals the sentinel, the update is skipped.
 */
export const MASK_SENTINEL = "••••••••";

/** Check whether a submitted form value is the mask sentinel (i.e. unchanged) */
export const isMaskSentinel = (value: string): boolean => value === MASK_SENTINEL;

/**
 * In-memory settings cache. Loads all rows in a single query and
 * serves subsequent reads from memory until the TTL expires or a
 * write invalidates the cache.
 */
export const SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * Decrypted page content cache. Pages like homepage, contact, terms
 * and website title change very rarely, so we cache the decrypted
 * values for 30 minutes per edge instance, avoiding repeated
 * AES-GCM decryption and DB round-trips on every public page view.
 * Invalidated immediately when content is saved via admin routes.
 */
const PAGE_CACHE_TTL_MS = 30 * 60 * 1_000;

type PageCacheEntry = { value: string | null; time: number };

const [getPageCacheMap, setPageCacheMap] = lazyRef<Map<string, PageCacheEntry>>(
  () => new Map(),
);

const getPageCacheEntry = (key: string): string | null | undefined => {
  const entry = getPageCacheMap().get(key);
  if (!entry) return undefined;
  if (nowMs() - entry.time >= PAGE_CACHE_TTL_MS) {
    getPageCacheMap().delete(key);
    return undefined;
  }
  return entry.value;
};

const setPageCacheEntry = (key: string, value: string | null): void => {
  getPageCacheMap().set(key, { value, time: nowMs() });
};

const invalidatePageCacheEntry = (key: string): void => {
  getPageCacheMap().delete(key);
};

/** Clear the entire page content cache (for testing or after bulk changes). */
export const invalidatePageCache = (): void => {
  setPageCacheMap(null);
};

type SettingsCacheState = {
  entries: Map<string, string> | null;
  time: number;
};

const [getSettingsCacheState, setSettingsCacheState] = lazyRef<SettingsCacheState>(
  () => ({ entries: null, time: 0 }),
);

const isCacheValid = (): boolean => {
  const state = getSettingsCacheState();
  return state.entries !== null && nowMs() - state.time < SETTINGS_CACHE_TTL_MS;
};

const settingsCacheSize = (): number => {
  const { entries } = getSettingsCacheState();
  return entries ? entries.size : 0;
};

registerCache(() => ({ name: "settings", entries: settingsCacheSize() }));

registerCache(() => ({
  name: "pageContent",
  entries: getPageCacheMap().size,
}));

/**
 * Load every setting row into the in-memory cache with a single query.
 */
export const loadAllSettings = async (): Promise<Map<string, string>> => {
  const rows = await queryAll<Settings>("SELECT key, value FROM settings");
  const cache = new Map<string, string>();
  for (const row of rows) {
    cache.set(row.key, row.value);
  }
  setSettingsCacheState({ entries: cache, time: nowMs() });
  return cache;
};

/**
 * Invalidate the settings cache (for testing or after writes).
 * Also clears the permanent timezone cache since it derives from settings,
 * and the page content cache since it derives from encrypted settings.
 */
export const invalidateSettingsCache = (): void => {
  setSettingsCacheState(null);
  invalidateTimezoneCache();
  invalidatePageCache();
};

/**
 * Get a setting value. Reads from the in-memory cache, loading all
 * settings in one query on first access or after TTL expiry.
 */
export const getSetting = async (key: string): Promise<string | null> => {
  const cache = isCacheValid()
    ? getSettingsCacheState().entries!
    : await loadAllSettings();
  return cache.get(key) ?? null;
};

/**
 * Set a setting value. Invalidates the cache so the next read
 * will pick up the new value.
 */
export const setSetting = async (key: string, value: string): Promise<void> => {
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    args: [key, value],
  });
  invalidateSettingsCache();
};

/** Get a boolean setting (stored as "true"/"false" string in DB). */
const getBoolSetting = async (key: string): Promise<boolean> => {
  const value = await getSetting(key);
  return value === "true";
};

/** Set a boolean setting (stored as "true"/"false" string in DB). */
const setBoolSetting = async (key: string, value: boolean): Promise<void> => {
  await setSetting(key, value ? "true" : "false");
};

/**
 * Set a setting value, or delete it if value is empty.
 * Common pattern for optional text settings.
 */
const setOrDeleteSetting = async (key: string, value: string): Promise<void> => {
  if (value === "") {
    await getDb().execute({
      sql: "DELETE FROM settings WHERE key = ?",
      args: [key],
    });
    invalidateSettingsCache();
    return;
  }
  await setSetting(key, value);
};

/**
 * Cached setup complete status using lazyRef pattern.
 * Once setup is complete (true), it can never go back to false,
 * so we cache it permanently to avoid per-request DB queries.
 */
const [getSetupCompleteCache, setSetupCompleteCache] = lazyRef<boolean>(
  () => false,
);

/**
 * Track whether we've confirmed setup is complete
 */
const [getSetupConfirmed, setSetupConfirmed] = lazyRef<boolean>(() => false);

/**
 * Check if initial setup has been completed
 * Result is cached in memory - once true, we never query again.
 */
export const isSetupComplete = async (): Promise<boolean> => {
  // Check both caches (avoid short-circuit to ensure consistent initialization)
  const confirmed = getSetupConfirmed();
  const cached = getSetupCompleteCache();
  if (confirmed && cached) return true;

  const isComplete = await getBoolSetting(CONFIG_KEYS.SETUP_COMPLETE);

  // Only cache positive result (setup complete is permanent)
  if (isComplete) {
    setSetupCompleteCache(true);
    setSetupConfirmed(true);
  }

  return isComplete;
};

/**
 * Clear setup complete cache (for testing)
 */
export const clearSetupCompleteCache = (): void => {
  setSetupCompleteCache(null);
  setSetupConfirmed(null);
};

/**
 * Complete initial setup by storing all configuration
 * Generates the encryption key hierarchy:
 * - DATA_KEY: random symmetric key for encrypting private key
 * - RSA key pair: public key encrypts attendee PII, private key decrypts
 * - KEK: derived from password hash + DB_ENCRYPTION_KEY, wraps DATA_KEY
 * Creates the first owner user row instead of storing credentials in settings.
 */
export const completeSetup = async (
  username: string,
  adminPassword: string,
  currencyCode: string,
): Promise<void> => {
  // Hash the password
  const hashedPassword = await hashPassword(adminPassword);

  // Generate DATA_KEY (random symmetric key)
  const dataKey = await generateDataKey();

  // Generate RSA key pair for asymmetric encryption
  const { publicKey, privateKey } = await generateKeyPair();

  // Derive KEK from password hash + DB_ENCRYPTION_KEY
  const kek = await deriveKEK(hashedPassword);

  // Wrap DATA_KEY with KEK
  const wrappedDataKey = await wrapKey(dataKey, kek);

  // Create the owner user row with wrapped data key
  await createUser(username, hashedPassword, wrappedDataKey, "owner");

  // Encrypt private key with DATA_KEY
  const encryptedPrivateKey = await encryptWithKey(privateKey, dataKey);
  await setSetting(CONFIG_KEYS.WRAPPED_PRIVATE_KEY, encryptedPrivateKey);

  // Store public key (plaintext - it's meant to be public)
  await setSetting(CONFIG_KEYS.PUBLIC_KEY, publicKey);

  await setSetting(CONFIG_KEYS.CURRENCY_CODE, currencyCode);
  await setSetting(CONFIG_KEYS.SETUP_COMPLETE, "true");
};

/**
 * Get currency code from database
 */
export const getCurrencyCodeFromDb = async (): Promise<string> => {
  const value = await getSetting(CONFIG_KEYS.CURRENCY_CODE);
  return value || "GBP";
};

/**
 * Get the configured payment provider type
 * Returns null if no provider is configured
 */
export const getPaymentProviderFromDb = (): Promise<string | null> =>
  getSetting(CONFIG_KEYS.PAYMENT_PROVIDER);

/**
 * Set the active payment provider type
 */
export const setPaymentProvider = async (
  provider: string,
): Promise<void> => {
  await setSetting(CONFIG_KEYS.PAYMENT_PROVIDER, provider);
};

/**
 * Clear the active payment provider (disables payments)
 */
export const clearPaymentProvider = async (): Promise<void> => {
  await getDb().execute({
    sql: "DELETE FROM settings WHERE key = ?",
    args: [CONFIG_KEYS.PAYMENT_PROVIDER],
  });
  invalidateSettingsCache();
};

/**
 * Check if a Stripe key has been configured in the database
 */
export const hasStripeKey = async (): Promise<boolean> => {
  const value = await getSetting(CONFIG_KEYS.STRIPE_SECRET_KEY);
  return value !== null;
};

/**
 * Get Stripe secret key from database (decrypted)
 * Returns null if not configured
 */
export const getStripeSecretKeyFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.STRIPE_SECRET_KEY);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Update Stripe secret key (encrypted at rest)
 */
export const updateStripeKey = async (
  stripeSecretKey: string,
): Promise<void> => {
  const encryptedKey = await encrypt(stripeSecretKey);
  await setSetting(CONFIG_KEYS.STRIPE_SECRET_KEY, encryptedKey);
};

/**
 * Get Stripe webhook secret from database (decrypted)
 * Returns null if not configured
 */
export const getStripeWebhookSecretFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.STRIPE_WEBHOOK_SECRET);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Get Stripe webhook endpoint ID from database
 * Returns null if not configured
 */
export const getStripeWebhookEndpointId = (): Promise<string | null> => {
  return getSetting(CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID);
};

/**
 * Store Stripe webhook configuration (secret encrypted, endpoint ID plaintext)
 */
export const setStripeWebhookConfig = async (
  config: { secret: string; endpointId: string },
): Promise<void> => {
  const encryptedSecret = await encrypt(config.secret);
  await setSetting(CONFIG_KEYS.STRIPE_WEBHOOK_SECRET, encryptedSecret);
  await setSetting(CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID, config.endpointId);
};

/**
 * Get the public key for encrypting attendee PII
 * Always available (it's meant to be public)
 */
export const getPublicKey = (): Promise<string | null> => {
  return getSetting(CONFIG_KEYS.PUBLIC_KEY);
};

/**
 * Get the wrapped private key (needs DATA_KEY to decrypt)
 */
export const getWrappedPrivateKey = (): Promise<string | null> => {
  return getSetting(CONFIG_KEYS.WRAPPED_PRIVATE_KEY);
};

/**
 * Update a user's password and re-wrap DATA_KEY with new KEK
 * Requires the user's old password hash (decrypted) and their user row
 */
export const updateUserPassword = async (
  userId: number,
  oldPasswordHash: string,
  oldWrappedDataKey: string,
  newPassword: string,
): Promise<boolean> => {
  // Unwrap DATA_KEY with old KEK
  const oldKek = await deriveKEK(oldPasswordHash);
  let dataKey: CryptoKey;
  try {
    dataKey = await unwrapKey(oldWrappedDataKey, oldKek);
  } catch {
    return false;
  }

  // Hash the new password
  const newHash = await hashPassword(newPassword);
  const encryptedNewHash = await encrypt(newHash);

  // Derive new KEK and re-wrap DATA_KEY
  const newKek = await deriveKEK(newHash);
  const newWrappedDataKey = await wrapKey(dataKey, newKek);

  // Update user row
  await getDb().execute({
    sql: "UPDATE users SET password_hash = ?, wrapped_data_key = ? WHERE id = ?",
    args: [encryptedNewHash, newWrappedDataKey, userId],
  });
  invalidateUsersCache();

  // Invalidate all sessions (force re-login with new password)
  await deleteAllSessions();

  return true;
};

/**
 * Check if a Square access token has been configured in the database
 */
export const hasSquareToken = async (): Promise<boolean> => {
  const value = await getSetting(CONFIG_KEYS.SQUARE_ACCESS_TOKEN);
  return value !== null;
};

/**
 * Get Square access token from database (decrypted)
 * Returns null if not configured
 */
export const getSquareAccessTokenFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.SQUARE_ACCESS_TOKEN);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Update Square access token (encrypted at rest)
 */
export const updateSquareAccessToken = async (
  accessToken: string,
): Promise<void> => {
  const encryptedToken = await encrypt(accessToken);
  await setSetting(CONFIG_KEYS.SQUARE_ACCESS_TOKEN, encryptedToken);
};

/**
 * Get Square webhook signature key from database (decrypted)
 * Returns null if not configured
 */
export const getSquareWebhookSignatureKeyFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Store Square webhook signature key (encrypted at rest)
 */
export const updateSquareWebhookSignatureKey = async (
  signatureKey: string,
): Promise<void> => {
  const encryptedKey = await encrypt(signatureKey);
  await setSetting(CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY, encryptedKey);
};

/**
 * Get Square location ID from database
 * Returns null if not configured
 */
export const getSquareLocationIdFromDb = (): Promise<string | null> =>
  getSetting(CONFIG_KEYS.SQUARE_LOCATION_ID);

/**
 * Store Square location ID (plaintext - not sensitive)
 */
export const updateSquareLocationId = async (
  locationId: string,
): Promise<void> => {
  await setSetting(CONFIG_KEYS.SQUARE_LOCATION_ID, locationId);
};

/**
 * Get Square sandbox mode from database.
 * Returns true if sandbox mode is enabled, false otherwise.
 */
export const getSquareSandboxFromDb = (): Promise<boolean> =>
  getBoolSetting(CONFIG_KEYS.SQUARE_SANDBOX);

/**
 * Update Square sandbox mode setting.
 */
export const updateSquareSandbox = (sandbox: boolean): Promise<void> =>
  setBoolSetting(CONFIG_KEYS.SQUARE_SANDBOX, sandbox);

/**
 * Get allowed embed hosts from database (decrypted)
 * Returns null if not configured (embedding allowed from anywhere)
 */
export const getEmbedHostsFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.EMBED_HOSTS);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Update allowed embed hosts (encrypted at rest)
 * Pass empty string to clear the restriction
 */
export const updateEmbedHosts = async (hosts: string): Promise<void> => {
  if (hosts === "") {
    return setOrDeleteSetting(CONFIG_KEYS.EMBED_HOSTS, "");
  }
  const encrypted = await encrypt(hosts);
  await setSetting(CONFIG_KEYS.EMBED_HOSTS, encrypted);
};

/** Max length for terms and conditions text */
export const MAX_TERMS_LENGTH = 10_240;

/**
 * Get terms and conditions text from database (30m cached).
 * Returns null if not configured.
 */
export const getTermsAndConditionsFromDb = async (): Promise<string | null> => {
  const cached = getPageCacheEntry(CONFIG_KEYS.TERMS_AND_CONDITIONS);
  if (cached !== undefined) return cached;
  const value = await getSetting(CONFIG_KEYS.TERMS_AND_CONDITIONS);
  setPageCacheEntry(CONFIG_KEYS.TERMS_AND_CONDITIONS, value);
  return value;
};

/**
 * Update terms and conditions text
 * Pass empty string to clear
 */
export const updateTermsAndConditions = async (text: string): Promise<void> => {
  await setOrDeleteSetting(CONFIG_KEYS.TERMS_AND_CONDITIONS, text);
  invalidatePageCacheEntry(CONFIG_KEYS.TERMS_AND_CONDITIONS);
};

/**
 * Permanent timezone cache. Timezone changes very rarely, so we cache it
 * indefinitely and update on explicit changes via updateTimezone().
 */
const [getTzCache, setTzCache] = lazyRef<string | null>(() => null);

/**
 * Get the configured timezone from database.
 * Returns the IANA timezone identifier, defaulting to Europe/London.
 * Also populates the permanent timezone cache for sync access via getTimezoneCached().
 */
export const getTimezoneFromDb = async (): Promise<string> => {
  const cached = getTzCache();
  if (cached !== null) return cached;
  const value = await getSetting(CONFIG_KEYS.TIMEZONE);
  const tz = value || DEFAULT_TIMEZONE;
  setTzCache(tz);
  return tz;
};

/**
 * Get the configured timezone synchronously.
 * Reads from the permanent cache, falling back to the TTL settings cache,
 * then to the default timezone. Safe to call from synchronous template code
 * because the middleware populates the settings cache on every request.
 */
export const getTimezoneCached = (): string => {
  const cached = getTzCache();
  if (cached !== null) return cached;
  const state = getSettingsCacheState();
  if (state.entries !== null) {
    const value = state.entries.get(CONFIG_KEYS.TIMEZONE) || DEFAULT_TIMEZONE;
    setTzCache(value);
    return value;
  }
  return DEFAULT_TIMEZONE;
};

/** Clear the permanent timezone cache (called by invalidateSettingsCache) */
const invalidateTimezoneCache = (): void => {
  setTzCache(null);
};

/**
 * Update the configured timezone.
 */
export const updateTimezone = async (tz: string): Promise<void> => {
  await setSetting(CONFIG_KEYS.TIMEZONE, tz);
  setTzCache(tz);
};

/**
 * Get the configured theme from database.
 * Returns "light" or "dark", defaulting to "light".
 */
export const getThemeFromDb = async (): Promise<string> => {
  const value = await getSetting(CONFIG_KEYS.THEME);
  return value === "dark" ? "dark" : "light";
};

/**
 * Update the configured theme.
 */
export const updateTheme = async (theme: string): Promise<void> => {
  const validTheme = theme === "dark" ? "dark" : "light";
  await setSetting(CONFIG_KEYS.THEME, validTheme);
};

/**
 * Get the "show public site" setting from database.
 * Returns true if the setting is "true", false otherwise.
 */
export const getShowPublicSiteFromDb = (): Promise<boolean> =>
  getBoolSetting(CONFIG_KEYS.SHOW_PUBLIC_SITE);

/**
 * Get the "show public site" setting synchronously from cache.
 * Returns false if the cache is not populated or the setting is not "true".
 * Safe to call from synchronous template code after the settings cache is warmed.
 */
export const getShowPublicSiteCached = (): boolean => {
  const state = getSettingsCacheState();
  if (state.entries !== null) {
    return state.entries.get(CONFIG_KEYS.SHOW_PUBLIC_SITE) === "true";
  }
  return false;
};

/**
 * Update the "show public site" setting.
 */
export const updateShowPublicSite = (show: boolean): Promise<void> =>
  setBoolSetting(CONFIG_KEYS.SHOW_PUBLIC_SITE, show);

/**
 * Get the "show public API" setting from database.
 */
export const getShowPublicApiFromDb = (): Promise<boolean> =>
  getBoolSetting(CONFIG_KEYS.SHOW_PUBLIC_API);

/**
 * Update the "show public API" setting.
 */
export const updateShowPublicApi = (show: boolean): Promise<void> =>
  setBoolSetting(CONFIG_KEYS.SHOW_PUBLIC_API, show);

/** Get an encrypted optional setting (decrypted). Returns null if not set. */
const getEncryptedSetting = async (key: string): Promise<string | null> => {
  const value = await getSetting(key);
  if (!value) return null;
  return decrypt(value);
};

/** Update an encrypted optional setting. Pass empty string to clear. */
const updateEncryptedSetting = async (key: string, text: string): Promise<void> => {
  if (text === "") return setOrDeleteSetting(key, "");
  await setSetting(key, await encrypt(text));
};

/** Max length for website title */
export const MAX_WEBSITE_TITLE_LENGTH = 128;

/** Max length for page text content */
export const MAX_PAGE_TEXT_LENGTH = 2048;

/** Get a page setting with 30m decrypted content cache. */
const getCachedPageSetting = async (key: string): Promise<string | null> => {
  const cached = getPageCacheEntry(key);
  if (cached !== undefined) return cached;
  const value = await getEncryptedSetting(key);
  setPageCacheEntry(key, value);
  return value;
};

/** Get the website title from database (decrypted, 30m cached). */
export const getWebsiteTitleFromDb = (): Promise<string | null> =>
  getCachedPageSetting(CONFIG_KEYS.WEBSITE_TITLE);

/** Update the website title (encrypted at rest). Pass empty string to clear. */
export const updateWebsiteTitle = async (text: string): Promise<void> => {
  await updateEncryptedSetting(CONFIG_KEYS.WEBSITE_TITLE, text);
  invalidatePageCacheEntry(CONFIG_KEYS.WEBSITE_TITLE);
};

/** Get the homepage text from database (decrypted, 30m cached). */
export const getHomepageTextFromDb = (): Promise<string | null> =>
  getCachedPageSetting(CONFIG_KEYS.HOMEPAGE_TEXT);

/** Update the homepage text (encrypted at rest). Pass empty string to clear. */
export const updateHomepageText = async (text: string): Promise<void> => {
  await updateEncryptedSetting(CONFIG_KEYS.HOMEPAGE_TEXT, text);
  invalidatePageCacheEntry(CONFIG_KEYS.HOMEPAGE_TEXT);
};

/** Get the contact page text from database (decrypted, 30m cached). */
export const getContactPageTextFromDb = (): Promise<string | null> =>
  getCachedPageSetting(CONFIG_KEYS.CONTACT_PAGE_TEXT);

/** Update the contact page text (encrypted at rest). Pass empty string to clear. */
export const updateContactPageText = async (text: string): Promise<void> => {
  await updateEncryptedSetting(CONFIG_KEYS.CONTACT_PAGE_TEXT, text);
  invalidatePageCacheEntry(CONFIG_KEYS.CONTACT_PAGE_TEXT);
};

/**
 * Get the configured phone prefix from database.
 * Returns the country calling code, defaulting to "44" (UK).
 */
export const getPhonePrefixFromDb = async (): Promise<string> => {
  const value = await getSetting(CONFIG_KEYS.PHONE_PREFIX);
  return value || "44";
};

/**
 * Update the configured phone prefix.
 */
export const updatePhonePrefix = async (prefix: string): Promise<void> => {
  await setSetting(CONFIG_KEYS.PHONE_PREFIX, prefix);
};

/** Get header image URL from database (decrypted). Returns null if not set. */
export const getHeaderImageUrlFromDb = (): Promise<string | null> =>
  getEncryptedSetting(CONFIG_KEYS.HEADER_IMAGE_URL);

/** Update header image URL (encrypted at rest). Pass empty string to clear. */
export const updateHeaderImageUrl = async (url: string): Promise<void> => {
  await updateEncryptedSetting(CONFIG_KEYS.HEADER_IMAGE_URL, url);
};

/** Get the configured email provider. Returns null if not configured. */
export const getEmailProviderFromDb = (): Promise<string | null> =>
  getSetting(CONFIG_KEYS.EMAIL_PROVIDER);

/** Update the configured email provider. Pass empty string to clear. */
export const updateEmailProvider = (provider: string): Promise<void> =>
  setOrDeleteSetting(CONFIG_KEYS.EMAIL_PROVIDER, provider);

/** Check if an email API key has been configured in the database */
export const hasEmailApiKey = async (): Promise<boolean> => {
  const value = await getSetting(CONFIG_KEYS.EMAIL_API_KEY);
  return value !== null;
};

/** Get email API key from database (decrypted). Returns null if not configured. */
export const getEmailApiKeyFromDb = (): Promise<string | null> =>
  getEncryptedSetting(CONFIG_KEYS.EMAIL_API_KEY);

/** Update email API key (encrypted at rest). Pass empty string to clear. */
export const updateEmailApiKey = (key: string): Promise<void> =>
  updateEncryptedSetting(CONFIG_KEYS.EMAIL_API_KEY, key);

/** Get email from address from database (decrypted). Returns null if not configured. */
export const getEmailFromAddressFromDb = (): Promise<string | null> =>
  getEncryptedSetting(CONFIG_KEYS.EMAIL_FROM_ADDRESS);

/** Update email from address (encrypted at rest). Pass empty string to clear. */
export const updateEmailFromAddress = (address: string): Promise<void> =>
  updateEncryptedSetting(CONFIG_KEYS.EMAIL_FROM_ADDRESS, address);

/** Valid email template types */
export type EmailTemplateType = "confirmation" | "admin";

/** Valid email template formats */
export type EmailTemplateFormat = "subject" | "html" | "text";

/** Config key for a given template type+format */
const emailTemplateKey = (type: EmailTemplateType, format: EmailTemplateFormat): string => {
  const keys: Record<`${EmailTemplateType}:${EmailTemplateFormat}`, string> = {
    "confirmation:subject": CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_SUBJECT,
    "confirmation:html": CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_HTML,
    "confirmation:text": CONFIG_KEYS.EMAIL_TPL_CONFIRMATION_TEXT,
    "admin:subject": CONFIG_KEYS.EMAIL_TPL_ADMIN_SUBJECT,
    "admin:html": CONFIG_KEYS.EMAIL_TPL_ADMIN_HTML,
    "admin:text": CONFIG_KEYS.EMAIL_TPL_ADMIN_TEXT,
  };
  return keys[`${type}:${format}`];
};

/** Max length for email templates */
export const MAX_EMAIL_TEMPLATE_LENGTH = 51_200;

/** Get a custom email template (decrypted). Returns null if not customised (use default). */
export const getEmailTemplate = (type: EmailTemplateType, format: EmailTemplateFormat): Promise<string | null> =>
  getEncryptedSetting(emailTemplateKey(type, format));

/** Update a custom email template (encrypted at rest). Pass empty string to clear (revert to default). */
export const updateEmailTemplate = (type: EmailTemplateType, format: EmailTemplateFormat, content: string): Promise<void> =>
  updateEncryptedSetting(emailTemplateKey(type, format), content);

/** Get all 3 parts of a custom email template (subject, html, text). Nulls mean "use default". */
export const getEmailTemplateSet = async (type: EmailTemplateType): Promise<{
  subject: string | null;
  html: string | null;
  text: string | null;
}> => {
  const [subject, html, text] = await Promise.all([
    getEmailTemplate(type, "subject"),
    getEmailTemplate(type, "html"),
    getEmailTemplate(type, "text"),
  ]);
  return { subject, html, text };
};

/** Get the custom domain from database. Returns null if not set. */
export const getCustomDomainFromDb = (): Promise<string | null> =>
  getSetting(CONFIG_KEYS.CUSTOM_DOMAIN);

/** Update the custom domain. Pass empty string to clear. */
export const updateCustomDomain = (domain: string): Promise<void> =>
  setOrDeleteSetting(CONFIG_KEYS.CUSTOM_DOMAIN, domain);

/** Get the custom domain last validated timestamp. Returns null if never validated. */
export const getCustomDomainLastValidatedFromDb = (): Promise<string | null> =>
  getSetting(CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED);

/** Update the custom domain last validated timestamp to now (UTC ISO 8601). */
export const updateCustomDomainLastValidated = (): Promise<void> =>
  setSetting(CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED, new Date().toISOString());

/**
 * Stubbable API for testing - allows mocking in ES modules
 * Use spyOn(settingsApi, "method") instead of spyOn(settingsModule, "method")
 */
export const settingsApi = {
  PAGE_CACHE_TTL_MS,
  completeSetup,
  getSetting,
  setSetting,
  loadAllSettings,
  invalidateSettingsCache,
  invalidatePageCache,
  isSetupComplete,
  clearSetupCompleteCache,
  getPublicKey,
  getWrappedPrivateKey,
  updateUserPassword,
  getCurrencyCodeFromDb,
  getPaymentProviderFromDb,
  setPaymentProvider,
  clearPaymentProvider,
  hasStripeKey,
  getStripeSecretKeyFromDb,
  updateStripeKey,
  getStripeWebhookSecretFromDb,
  getStripeWebhookEndpointId,
  setStripeWebhookConfig,
  hasSquareToken,
  getSquareAccessTokenFromDb,
  updateSquareAccessToken,
  getSquareWebhookSignatureKeyFromDb,
  updateSquareWebhookSignatureKey,
  getSquareLocationIdFromDb,
  updateSquareLocationId,
  getSquareSandboxFromDb,
  updateSquareSandbox,
  getEmbedHostsFromDb,
  updateEmbedHosts,
  getTermsAndConditionsFromDb,
  updateTermsAndConditions,
  getTimezoneFromDb,
  updateTimezone,
  getThemeFromDb,
  updateTheme,
  getShowPublicSiteFromDb,
  getShowPublicSiteCached,
  updateShowPublicSite,
  getWebsiteTitleFromDb,
  updateWebsiteTitle,
  getHomepageTextFromDb,
  updateHomepageText,
  getContactPageTextFromDb,
  updateContactPageText,
  getPhonePrefixFromDb,
  updatePhonePrefix,
  getHeaderImageUrlFromDb,
  updateHeaderImageUrl,
  getShowPublicApiFromDb,
  updateShowPublicApi,
  getEmailProviderFromDb,
  updateEmailProvider,
  hasEmailApiKey,
  getEmailApiKeyFromDb,
  updateEmailApiKey,
  getEmailFromAddressFromDb,
  updateEmailFromAddress,
  getEmailTemplate,
  updateEmailTemplate,
  getEmailTemplateSet,
  getCustomDomainFromDb,
  updateCustomDomain,
  getCustomDomainLastValidatedFromDb,
  updateCustomDomainLastValidated,
};
