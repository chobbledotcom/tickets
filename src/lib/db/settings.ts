/**
 * Settings table operations
 */

import { lazyRef } from "#fp";
import { decrypt, encrypt, hashPassword, verifyPassword } from "#lib/crypto.ts";
import { getDb } from "#lib/db/client.ts";
import { deleteAllSessions } from "#lib/db/sessions.ts";
import type { Settings } from "#lib/types.ts";

/**
 * Setting keys for configuration
 */
export const CONFIG_KEYS = {
  ADMIN_PASSWORD: "admin_password",
  STRIPE_KEY: "stripe_key",
  CURRENCY_CODE: "currency_code",
  SETUP_COMPLETE: "setup_complete",
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
 * Passwords are hashed using scrypt before storage
 * Sensitive values are encrypted at rest
 */
export const completeSetup = async (
  adminPassword: string,
  stripeSecretKey: string | null,
  currencyCode: string,
): Promise<void> => {
  const hashedPassword = await hashPassword(adminPassword);
  const encryptedHash = await encrypt(hashedPassword);
  await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, encryptedHash);
  if (stripeSecretKey) {
    const encryptedKey = await encrypt(stripeSecretKey);
    await setSetting(CONFIG_KEYS.STRIPE_KEY, encryptedKey);
  }
  await setSetting(CONFIG_KEYS.CURRENCY_CODE, currencyCode);
  await setSetting(CONFIG_KEYS.SETUP_COMPLETE, "true");
};

/**
 * Get Stripe secret key from database (decrypted)
 */
export const getStripeSecretKeyFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.STRIPE_KEY);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Check if a Stripe key has been configured
 */
export const hasStripeKey = async (): Promise<boolean> => {
  const value = await getSetting(CONFIG_KEYS.STRIPE_KEY);
  return value !== null;
};

/**
 * Update Stripe secret key (encrypted at rest)
 */
export const updateStripeKey = async (
  stripeSecretKey: string,
): Promise<void> => {
  const encryptedKey = await encrypt(stripeSecretKey);
  await setSetting(CONFIG_KEYS.STRIPE_KEY, encryptedKey);
};

/**
 * Get currency code from database
 */
export const getCurrencyCodeFromDb = async (): Promise<string> => {
  const value = await getSetting(CONFIG_KEYS.CURRENCY_CODE);
  return value || "GBP";
};

/**
 * Get admin password hash from database (decrypted)
 * Returns null if setup hasn't been completed
 */
export const getAdminPasswordFromDb = async (): Promise<string | null> => {
  const value = await getSetting(CONFIG_KEYS.ADMIN_PASSWORD);
  if (!value) return null;
  return decrypt(value);
};

/**
 * Verify admin password using constant-time comparison
 * Checks the database-stored password hash only
 */
export const verifyAdminPassword = async (
  password: string,
): Promise<boolean> => {
  const storedHash = await getAdminPasswordFromDb();
  if (storedHash === null) return false;
  return verifyPassword(password, storedHash);
};

/**
 * Update admin password and invalidate all existing sessions
 * Passwords are hashed using scrypt before storage and encrypted at rest
 */
export const updateAdminPassword = async (
  newPassword: string,
): Promise<void> => {
  const hashedPassword = await hashPassword(newPassword);
  const encryptedHash = await encrypt(hashedPassword);
  await setSetting(CONFIG_KEYS.ADMIN_PASSWORD, encryptedHash);
  await deleteAllSessions();
};
