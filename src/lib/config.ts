/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Only DB_URL and DB_TOKEN come from environment variables
 */

import {
  getCurrencyCodeFromDb,
  getStripeSecretKeyFromDb,
  isSetupComplete,
} from "#lib/db/settings.ts";

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
export const getCurrencyCode = (): Promise<string> => {
  return getCurrencyCodeFromDb();
};

/**
 * Get allowed domain for security validation (build-time config)
 * This is a required build-time configuration that hardens origin validation
 */
export const getAllowedDomain = (): string => {
  return Deno.env.get("ALLOWED_DOMAIN") as string;
};

/**
 * Check if initial setup has been completed
 */
export { isSetupComplete };
