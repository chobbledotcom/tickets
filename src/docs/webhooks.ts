/**
 * Webhook delivery and API examples.
 *
 * Sends registration notifications to configured webhook URLs
 * with event and attendee details. Includes example payloads
 * for the public JSON API.
 *
 * @module
 */

export {
  buildWebhookPayload,
  logAndNotifyMultiRegistration,
  logAndNotifyRegistration,
  type RegistrationEntry,
  sendRegistrationWebhooks,
  sendWebhook,
  type WebhookAttendee,
  type WebhookEvent as WebhookPayloadEvent,
  type WebhookPayload,
  type WebhookTicket,
} from "#lib/webhook.ts";
export * from "#lib/webhook-example.ts";
export * from "#lib/api-example.ts";
