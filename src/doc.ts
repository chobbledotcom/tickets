/**
 * # Chobble Tickets
 *
 * A self-hosted ticket reservation system built on Deno with libsql.
 *
 * ## Features
 *
 * - Free and paid events (Stripe/Square integration)
 * - Standard events (fixed capacity) and daily events (date-based booking)
 * - Multi-event bookings in one checkout
 * - Hybrid RSA-OAEP + AES-256-GCM encryption for PII at rest
 * - Check-in with QR codes (built-in scanner)
 * - Apple Wallet pass support
 * - Admin dashboard with multi-user management
 * - Email notifications (Resend, Postmark, SendGrid, Mailgun)
 * - Public JSON API (optional)
 * - Webhooks on registration
 * - ICS/RSS calendar feeds
 * - Embeddable widget via iframe
 *
 * ## Deployment Options
 *
 * - Bunny Edge Scripting (edge-deployed)
 * - Docker containers
 * - Any Deno-compatible environment
 *
 * @module
 */

export * from "#fp";
export * from "#lib/api-example.ts";
export * from "#lib/apple-wallet.ts";
export * from "#lib/booking.ts";
export * from "#lib/bunny-cdn.ts";
export * from "#lib/business-email.ts";
export * from "#lib/cache-registry.ts";
export * from "#lib/config.ts";
export * from "#lib/cookies.ts";
export * from "#lib/crypto.ts";
export * from "#lib/csrf.ts";
export * from "#lib/currency.ts";
export * from "#lib/dates.ts";
export * from "#lib/db/activityLog.ts";
export * from "#lib/db/attendees.ts";
export * from "#lib/db/client.ts";
export * from "#lib/db/common-schema.ts";
export * from "#lib/db/define-id-table.ts";
export * from "#lib/db/events.ts";
export * from "#lib/db/groups.ts";
export * from "#lib/db/holidays.ts";
export * from "#lib/db/login-attempts.ts";
export * from "#lib/db/migrations.ts";
export * from "#lib/db/processed-payments.ts";
export * from "#lib/db/query.ts";
export * from "#lib/db/query-log.ts";
export * from "#lib/db/sessions.ts";
export * from "#lib/db/settings.ts";
export * from "#lib/db/table.ts";
export * from "#lib/db/users.ts";
export * from "#lib/demo.ts";
export * from "#lib/email.ts";
export * from "#lib/email-renderer.ts";
export * from "#lib/embed.ts";
export * from "#lib/embed-hosts.ts";
export * from "#lib/env.ts";
export * from "#lib/event-fields.ts";
export * from "#lib/iframe.ts";
export * from "#lib/logger.ts";
export * from "#lib/markdown.ts";
export * from "#lib/now.ts";
export * from "#lib/ntfy.ts";
export * from "#lib/payment-crypto.ts";
export * from "#lib/payment-helpers.ts";
export * from "#lib/payments.ts";
export * from "#lib/pending-work.ts";
export * from "#lib/phone.ts";
export * from "#lib/qr.ts";
export * from "#lib/seeds.ts";
export * from "#lib/session-context.ts";
export * from "#lib/slug.ts";
export * from "#lib/sort-events.ts";
export * from "#lib/storage.ts";
export * from "#lib/svg-ticket.ts";
export * from "#lib/theme.ts";
export * from "#lib/ticket-url.ts";
export * from "#lib/timezone.ts";
export * from "#lib/types.ts";
export * from "#lib/wallet-icons.ts";
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
