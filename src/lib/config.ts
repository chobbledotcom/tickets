/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Only DB_URL and DB_TOKEN come from environment variables
 */

import { getCurrencyCodeFromDb, getStripeSecretKeyFromDb } from "./db.ts";

/**
 * Get Stripe secret key from database
 * Returns null if not set (payments disabled)
 */
export const getStripeSecretKey = async (): Promise<string | null> => {
  const key = await getStripeSecretKeyFromDb();
  return key && key.trim() !== "" ? key : null;
};

/**
 * Check if Stripe payments are enabled
 */
export const isPaymentsEnabled = async (): Promise<boolean> => {
  return (await getStripeSecretKey()) !== null;
};

/**
 * Get currency code from database
 * Defaults to GBP if not set
 */
export const getCurrencyCode = async (): Promise<string> => {
  return getCurrencyCodeFromDb();
};

/**
 * Get database URL from environment
 */
export const getDbUrl = (): string | undefined => {
  return process.env.DB_URL;
};

/**
 * Get database auth token from environment
 */
export const getDbToken = (): string | undefined => {
  return process.env.DB_TOKEN;
};

/**
 * Get server port from environment
 */
export const getPort = (): number => {
  return Number.parseInt(process.env.PORT || "3000", 10);
};

/**
 * Check if initial setup has been completed
 */
export { isSetupComplete } from "./db.ts";
