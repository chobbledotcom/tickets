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

import type { WebhookPayload } from "#shared/webhook.ts";

/** Example inputs used by both the fixture and the test */
export const EXAMPLE_LISTING = {
  name: "Summer Workshop",
  slug: "summer-workshop",
  unit_price: 1500,
} as const;

export const EXAMPLE_ATTENDEE = {
  address: "42 Oak Lane, Bristol, BS1 1AA",
  date: "2025-08-20",
  email: "alice@example.com",
  name: "Alice Smith",
  payment_id: "pi_3abc123def456",
  phone: "+44 7700 900000",
  price_paid: "3000",
  quantity: 2,
  remaining_balance: 0,
  special_instructions: "Wheelchair access needed",
  ticket_token: "A1B2C3D4E5",
} as const;

export const EXAMPLE_CURRENCY = "GBP";
const EXAMPLE_DOMAIN = "tickets.example.com";
export const EXAMPLE_BUSINESS_EMAIL = "hello@example.com";

/** The example payload, matching what buildWebhookPayload would produce */
export const WEBHOOK_EXAMPLE_PAYLOAD: WebhookPayload = {
  address: EXAMPLE_ATTENDEE.address,
  amount_owed: EXAMPLE_ATTENDEE.remaining_balance,
  business_email: EXAMPLE_BUSINESS_EMAIL,
  currency: EXAMPLE_CURRENCY,
  email: EXAMPLE_ATTENDEE.email,
  name: EXAMPLE_ATTENDEE.name,
  notification_type: "registration.completed",
  payment_id: EXAMPLE_ATTENDEE.payment_id,
  phone: EXAMPLE_ATTENDEE.phone,
  price_paid: Number.parseInt(EXAMPLE_ATTENDEE.price_paid, 10),
  special_instructions: EXAMPLE_ATTENDEE.special_instructions,
  ticket_url: `https://${EXAMPLE_DOMAIN}/t/${EXAMPLE_ATTENDEE.ticket_token}`,
  tickets: [
    {
      date: EXAMPLE_ATTENDEE.date,
      listing_name: EXAMPLE_LISTING.name,
      listing_slug: EXAMPLE_LISTING.slug,
      quantity: EXAMPLE_ATTENDEE.quantity,
      ticket_token: EXAMPLE_ATTENDEE.ticket_token,
      unit_price: EXAMPLE_LISTING.unit_price,
    },
  ],
  timestamp: "2025-08-20T14:30:00.000Z",
};

/** Pretty-printed JSON for embedding in documentation */
export const WEBHOOK_EXAMPLE_JSON: string = JSON.stringify(
  WEBHOOK_EXAMPLE_PAYLOAD,
  null,
  2,
);
