/**
 * The routes that stay writable while the site is read-only.
 *
 * These are public pages and machine endpoints, not admin pages, so they do
 * not belong in the admin surface. Each stays open because a working site
 * cannot pause it. A customer pays. A sender redelivers. A device registers
 * its pass. A door scans a ticket.
 */

export type ReadOnlySafeRoute = {
  /** The route pattern, as the route table names it. */
  readonly pattern: string;
  /** The sender redelivers after a non-2xx answer, so update mode answers
   * this route like an API call instead of with the human redirect. */
  readonly retryingWebhook?: true;
};

export const READ_ONLY_SAFE_ROUTES: readonly ReadOnlySafeRoute[] = [
  // A customer renews a listing, so the sale cannot pause.
  { pattern: "/renew" },
  // A customer settles an outstanding balance.
  { pattern: "/pay/:token" },
  // The provider redelivers a payment that lands mid-update.
  { pattern: "/payment/webhook", retryingWebhook: true },
  // An Apple device registers, or removes, its pass.
  { pattern: "/v1/devices/:_device/registrations/:_passType/:_token" },
  // The Apple Wallet webservice accepts device log lines.
  { pattern: "/v1/log" },
  // The SMS gateway redelivers a message that lands mid-update.
  { pattern: "/sms/webhook", retryingWebhook: true },
  // An invited user accepts the invitation.
  { pattern: "/join/:code" },
  // A reader unsubscribes from the mailing list.
  { pattern: "/unsubscribe" },
  // A visitor sends the contact form.
  { pattern: "/contact" },
  // Another site asks this one for the credentials it hosts.
  { pattern: "/instance/site-credentials" },
  // The door checks a ticket in or out.
  { pattern: "/checkin/:tokens" },
];
