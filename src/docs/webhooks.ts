/**
 * Webhook delivery and API examples.
 *
 * Sends registration notifications to configured webhook URLs
 * with listing and attendee details. Includes example payloads
 * for the public JSON API.
 *
 * @module
 */

export * from "#shared/api-example.ts";
export {
  logAndNotifyRegistration,
  sendRegistrationWebhooks,
  sendWebhook,
} from "#shared/webhook/delivery.ts";
export {
  buildWebhookPayload,
  type RegistrationEntry,
  type WebhookAttendee,
  type WebhookListing as WebhookPayloadListing,
  type WebhookPayload,
  type WebhookTicket,
} from "#shared/webhook.ts";
export * from "#shared/webhook-example.ts";
