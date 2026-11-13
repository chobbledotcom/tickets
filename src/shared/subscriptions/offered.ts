/** Whether the listing form offers the subscription plan boxes. */

import { settings } from "#db/settings.ts";

/** The form offers the plan while the feature is on, also after the site
 * leaves Stripe, so the owner can still choose Never. The save rule refuses a
 * plan that Stripe cannot charge. */
export const subscriptionsOffered = (): boolean =>
  settings.features.subscriptions;
