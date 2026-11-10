/** Whether the site can sell a subscription ticket now. */

import { settings } from "#db/settings.ts";

/** Only Stripe charges a subscription for this site, so the recurring price
 * shows only while the feature is on and Stripe takes new payments. */
export const subscriptionsOffered = (): boolean =>
  settings.features.subscriptions && settings.paymentProvider === "stripe";
