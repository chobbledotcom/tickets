/**
 * Settings table operations
 */

import { lazyRef } from "#fp";
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
import { getDb } from "#lib/db/client.ts";
import { deleteAllSessions } from "#lib/db/sessions.ts";
import { createUser } from "#lib/db/users.ts";
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
} as const;

/**
 * Get a setting value
 */
export const getSetting = async (key: string): Promise<string | null> => {
  const result = await getDb().execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [key],
  });
  if (result.rows.length === 0) return null;
  return (result.rows[0] as unknown as Settings).value;
};

/**
 * Set a setting value
 */
export const setSetting = async (key: string, value: string): Promise<void> => {
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    args: [key, value],
  });
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

  const value = await getSetting(CONFIG_KEYS.SETUP_COMPLETE);
  const isComplete = value === "true";

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
  webhookSecret: string,
  endpointId: string,
): Promise<void> => {
  const encryptedSecret = await encrypt(webhookSecret);
  await setSetting(CONFIG_KEYS.STRIPE_WEBHOOK_SECRET, encryptedSecret);
  await setSetting(CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID, endpointId);
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
 * Stubbable API for testing - allows mocking in ES modules
 * Use spyOn(settingsApi, "method") instead of spyOn(settingsModule, "method")
 */
export const settingsApi = {
  completeSetup,
  getSetting,
  setSetting,
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
};
