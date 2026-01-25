/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Stripe secret key is configured via admin settings (stored encrypted in DB)
 */

import {
  getCurrencyCodeFromDb,
  getStripeSecretKeyFromDb,
  isSetupComplete,
} from "#lib/db/settings.ts";

/**
 * Get Stripe secret key from database (encrypted)
 * Returns null if not configured (payments disabled)
 */
export const getStripeSecretKey = (): Promise<string | null> => {
  return getStripeSecretKeyFromDb();
};

/**
 * Get Stripe publishable key from environment variable
 * Returns null if not set
 */
export const getStripePublishableKey = (): string | null => {
  const key = Deno.env.get("STRIPE_PUBLISHABLE_KEY");
  return key && key.trim() !== "" ? key : null;
};

/**
 * Get Stripe webhook signing secret from environment variable
 * Required for verifying webhook signatures
 */
export const getStripeWebhookSecret = (): string | null => {
  const key = Deno.env.get("STRIPE_WEBHOOK_SECRET");
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
