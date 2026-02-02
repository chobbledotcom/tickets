/**
 * Configuration module for ticket reservation system
 * Reads configuration from database (set during setup phase)
 * Payment provider and keys are configured via admin settings (stored encrypted in DB)
 */

import {
  getCurrencyCodeFromDb,
  getPaymentProviderFromDb,
  getSquareAccessTokenFromDb,
  getSquareLocationIdFromDb,
  getSquareWebhookSignatureKeyFromDb,
  getStripeSecretKeyFromDb,
  getStripeWebhookSecretFromDb,
  hasSquareToken,
  hasStripeKey,
  isSetupComplete,
} from "#lib/db/settings.ts";
import { getEnv } from "#lib/env.ts";
import type { PaymentProviderType } from "#lib/payments.ts";

/**
 * Get the configured payment provider type
 * Returns null if no provider is configured
 */
export const getPaymentProvider = async (): Promise<PaymentProviderType | null> => {
  const provider = await getPaymentProviderFromDb();
  if (provider === "stripe") return "stripe";
  if (provider === "square") return "square";
  return null;
};

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
  const key = getEnv("STRIPE_PUBLISHABLE_KEY");
  return key && key.trim() !== "" ? key : null;
};

/**
 * Get Stripe webhook signing secret from database (encrypted)
 * Automatically configured when Stripe secret key is saved
 */
export const getStripeWebhookSecret = (): Promise<string | null> => {
  return getStripeWebhookSecretFromDb();
};

/** Stubbable API for internal calls (testable via spyOn, like stripeApi/squareApi) */
export const configApi = {
  getPaymentProvider,
};

/**
 * Check if payments are enabled (any provider configured with valid keys)
 */
export const isPaymentsEnabled = async (): Promise<boolean> => {
  const provider = await configApi.getPaymentProvider();
  if (provider === "stripe") return hasStripeKey();
  if (provider === "square") return hasSquareToken();
  return false;
};

/**
 * Get Square access token from database (encrypted)
 * Returns null if not configured
 */
export const getSquareAccessToken = (): Promise<string | null> =>
  getSquareAccessTokenFromDb();

/**
 * Get Square webhook signature key from database (encrypted)
 * Returns null if not configured
 */
export const getSquareWebhookSignatureKey = (): Promise<string | null> =>
  getSquareWebhookSignatureKeyFromDb();

/**
 * Get Square location ID from database
 * Returns null if not configured
 */
export const getSquareLocationId = (): Promise<string | null> =>
  getSquareLocationIdFromDb();

/**
 * Get currency code from database
 * Defaults to GBP if not set
 */
export const getCurrencyCode = (): Promise<string> => {
  return getCurrencyCodeFromDb();
};

/**
 * Get allowed domain for security validation (runtime config via Bunny secrets)
 * This is a required configuration that hardens origin validation
 */
export const getAllowedDomain = (): string => {
  return getEnv("ALLOWED_DOMAIN") as string;
};

/**
 * Check if initial setup has been completed
 */
export { isSetupComplete };
