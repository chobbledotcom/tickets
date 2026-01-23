/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Only DB_URL and DB_TOKEN come from environment variables
 */

import { getCurrencyCodeFromDb, getStripeSecretKeyFromDb } from "./db/index.ts";

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
 * Check if initial setup has been completed
 */
export { isSetupComplete } from "./db/index.ts";
