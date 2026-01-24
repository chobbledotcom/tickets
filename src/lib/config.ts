/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Stripe keys come from environment variables for security
 */

import { getCurrencyCodeFromDb, isSetupComplete } from "#lib/db/settings.ts";

/**
 * Get Stripe secret key from environment variable
 * Returns null if not set (payments disabled)
 */
export const getStripeSecretKey = (): string | null => {
  const key = process.env.STRIPE_SECRET_KEY;
  return key && key.trim() !== "" ? key : null;
};

/**
 * Get Stripe publishable key from environment variable
 * Returns null if not set
 */
export const getStripePublishableKey = (): string | null => {
  const key = process.env.STRIPE_PUBLISHABLE_KEY;
  return key && key.trim() !== "" ? key : null;
};

/**
 * Check if Stripe payments are enabled
 */
export const isPaymentsEnabled = (): boolean => {
  return getStripeSecretKey() !== null;
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
