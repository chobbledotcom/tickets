/**
 * Webhook delivery and API examples.
 *
 * Sends registration notifications to configured webhook URLs
 * with event and attendee details. Includes example payloads
 * for the public JSON API.
 *
 * @module
 */

export * from "#shared/api-example.ts";
export {
  buildWebhookPayload,
  logAndNotifyRegistration,
  type RegistrationEntry,
  sendRegistrationWebhooks,
  sendWebhook,
  type WebhookAttendee,
  type WebhookEvent as WebhookPayloadEvent,
  type WebhookPayload,
  type WebhookTicket,
} from "#shared/webhook.ts";
export * from "#shared/webhook-example.ts";
