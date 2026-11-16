/** Limits of the subscription status check. */

/** The number of subscriptions that one check takes. Each costs two Stripe
 * reads, then one ledger read and one write. With this batch, the check fits
 * in one scheduled request with the database pruning and the activity
 * backfill. */
export const SUBSCRIPTION_CHECK_BATCH = 5;

/** How far apart two passes over the subscriptions sit. A renewal lands on
 * the day Stripe took it, whenever the check records it. */
export const SUBSCRIPTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;
