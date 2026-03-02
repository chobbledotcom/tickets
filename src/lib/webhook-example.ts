/**
 * Example webhook payload for documentation.
 *
 * This constant is rendered in the admin guide and README.
 * A test in test/lib/webhook-example.test.ts calls the real
 * buildWebhookPayload() with matching inputs and asserts
 * the output has the same keys, types, and structure —
 * so a payload shape change will break the test and force
 * an update here.
 */

import type { WebhookPayload } from "#lib/webhook.ts";

/** Example inputs used by both the fixture and the test */
export const EXAMPLE_EVENT = {
  name: "Summer Workshop",
  slug: "summer-workshop",
  unit_price: 1500,
} as const;

export const EXAMPLE_ATTENDEE = {
  name: "Alice Smith",
  email: "alice@example.com",
  phone: "+44 7700 900000",
  address: "42 Oak Lane, Bristol, BS1 1AA",
  special_instructions: "Wheelchair access needed",
  quantity: 2,
  payment_id: "pi_3abc123def456",
  price_paid: "3000",
  ticket_token: "A1B2C3D4E5",
  date: "2025-08-20",
} as const;

export const EXAMPLE_CURRENCY = "GBP";
const EXAMPLE_DOMAIN = "tickets.example.com";
export const EXAMPLE_BUSINESS_EMAIL = "hello@example.com";

/** The example payload, matching what buildWebhookPayload would produce */
export const WEBHOOK_EXAMPLE_PAYLOAD: WebhookPayload = {
  event_type: "registration.completed",
  name: EXAMPLE_ATTENDEE.name,
  email: EXAMPLE_ATTENDEE.email,
  phone: EXAMPLE_ATTENDEE.phone,
  address: EXAMPLE_ATTENDEE.address,
  special_instructions: EXAMPLE_ATTENDEE.special_instructions,
  price_paid: Number.parseInt(EXAMPLE_ATTENDEE.price_paid, 10),
  currency: EXAMPLE_CURRENCY,
  payment_id: EXAMPLE_ATTENDEE.payment_id,
  ticket_url: `https://${EXAMPLE_DOMAIN}/t/${EXAMPLE_ATTENDEE.ticket_token}`,
  tickets: [
    {
      event_name: EXAMPLE_EVENT.name,
      event_slug: EXAMPLE_EVENT.slug,
      unit_price: EXAMPLE_EVENT.unit_price,
      quantity: EXAMPLE_ATTENDEE.quantity,
      date: EXAMPLE_ATTENDEE.date,
      ticket_token: EXAMPLE_ATTENDEE.ticket_token,
    },
  ],
  timestamp: "2025-08-20T14:30:00.000Z",
  business_email: EXAMPLE_BUSINESS_EMAIL,
};

/** Pretty-printed JSON for embedding in documentation */
export const WEBHOOK_EXAMPLE_JSON: string = JSON.stringify(
  WEBHOOK_EXAMPLE_PAYLOAD,
  null,
  2,
);
