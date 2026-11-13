/** Whether the listing form offers the subscription plan boxes. */

import { settings } from "#db/settings.ts";

/** Keep the boxes after the site leaves Stripe so the owner can clear the
 * recurring price. The save rule requires Stripe for a non-empty plan. */
export const subscriptionsOffered = (): boolean =>
  settings.features.subscriptions;
