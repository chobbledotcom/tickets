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
 * ## Modules
 *
 * | Module | Description |
 * |--------|-------------|
 * | [Database](./docs/database.ts) | ORM, table abstractions, and entity CRUD |
 * | [Crypto](./docs/crypto.ts) | Encryption, hashing, and CSRF |
 * | [Payments](./docs/payments.ts) | Stripe and Square integration |
 * | [Email](./docs/email.ts) | Email sending and templates |
 * | [Tickets](./docs/tickets.ts) | QR codes, SVG tickets, Apple Wallet |
 * | [Events](./docs/events.ts) | Event fields, sorting, availability |
 * | [Config](./docs/config.ts) | Settings, environment, sessions |
 * | [Utilities](./docs/utilities.ts) | FP helpers, formatting, caching |
 * | [Embed](./docs/embed.ts) | Widget embedding and CDN |
 * | [Webhooks](./docs/webhooks.ts) | Webhook delivery and API examples |
 * | [Demo](./docs/demo.ts) | Demo mode and seed data |
 *
 * ## Deployment Options
 *
 * - Bunny Edge Scripting (edge-deployed)
 * - Docker containers
 * - Any Deno-compatible environment
 *
 * @module
 */

export * from "./docs/database.ts";
export * from "./docs/crypto.ts";
export * from "./docs/payments.ts";
export * from "./docs/email.ts";
export * from "./docs/tickets.ts";
export * from "./docs/events.ts";
export * from "./docs/config.ts";
export * from "./docs/utilities.ts";
export * from "./docs/embed.ts";
export * from "./docs/webhooks.ts";
export * from "./docs/demo.ts";
