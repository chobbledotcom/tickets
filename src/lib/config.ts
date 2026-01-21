/**
 * Configuration module for ticket reservation system
 * Reads environment variables with defaults
 */

/**
 * Get Stripe secret key from environment
 * Returns null if not set (payments disabled)
 */
export const getStripeSecretKey = (): string | null => {
  const key = process.env.STRIPE_SECRET_KEY;
  return key && key.trim() !== "" ? key : null;
};

/**
 * Check if Stripe payments are enabled
 */
export const isPaymentsEnabled = (): boolean => {
  return getStripeSecretKey() !== null;
};

/**
 * Get currency code from environment
 * Defaults to GBP if not set
 */
export const getCurrencyCode = (): string => {
  return process.env.CURRENCY_CODE || "GBP";
};

/**
 * Get database URL from environment
 */
export const getDbUrl = (): string => {
  return process.env.DB_URL || "file:tickets.db";
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
