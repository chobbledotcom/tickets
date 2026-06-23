/**
 * Tests that the webhook example in the documentation matches the real
 * buildWebhookPayload() output. If the payload shape changes, this test
 * fails and forces an update to src/shared/webhook-example.ts (and thus the
 * admin guide and README).
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import {
  buildWebhookPayload,
  type RegistrationEntry,
} from "#shared/webhook.ts";
import {
  EXAMPLE_ATTENDEE,
  EXAMPLE_BUSINESS_EMAIL,
  EXAMPLE_CURRENCY,
  EXAMPLE_LISTING,
  WEBHOOK_EXAMPLE_JSON,
  WEBHOOK_EXAMPLE_PAYLOAD,
} from "#shared/webhook-example.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils";

/** Extract the domain from the example ticket_url (e.g. "https://x.com/t/..." → "x.com") */
const exampleDomain = new URL(WEBHOOK_EXAMPLE_PAYLOAD.ticket_url).hostname;

describe("webhook example", () => {
  let domainStub: { restore: () => void };
  let time: FakeTime;

  beforeEach(async () => {
    await resetDb();
    await createTestDbWithSetup(EXAMPLE_CURRENCY);

    const { settings: s } = await import("#shared/db/settings.ts");
    s.invalidateCache();

    // Set business email to match the example
    const { updateBusinessEmail } = await import("#shared/validation/email.ts");
    await updateBusinessEmail(EXAMPLE_BUSINESS_EMAIL);

    // Set effective domain to match the example domain
    setEffectiveDomainForTest(exampleDomain);
    domainStub = {
      restore: () => {
        resetEffectiveDomain();
      },
    };

    // Fix time to match the example timestamp
    time = new FakeTime(new Date(WEBHOOK_EXAMPLE_PAYLOAD.timestamp));
  });

  afterEach(() => {
    time.restore();
    domainStub.restore();
    resetDb();
  });

  /** Build a RegistrationEntry from the example constants */
  const exampleEntry = (): RegistrationEntry => ({
    attendee: {
      address: EXAMPLE_ATTENDEE.address,
      date: EXAMPLE_ATTENDEE.date,
      email: EXAMPLE_ATTENDEE.email,
      end_date: null,
      id: 1,
      name: EXAMPLE_ATTENDEE.name,
      payment_id: EXAMPLE_ATTENDEE.payment_id,
      phone: EXAMPLE_ATTENDEE.phone,
      price_paid: EXAMPLE_ATTENDEE.price_paid,
      quantity: EXAMPLE_ATTENDEE.quantity,
      remaining_balance: EXAMPLE_ATTENDEE.remaining_balance,
      special_instructions: EXAMPLE_ATTENDEE.special_instructions,
      ticket_token: EXAMPLE_ATTENDEE.ticket_token,
    },
    listing: {
      attendee_count: 10,
      can_pay_more: false,
      customisable_days: false,
      day_prices: {},
      id: 1,
      max_attendees: 100,
      months_per_unit: 0,
      name: EXAMPLE_LISTING.name,
      slug: EXAMPLE_LISTING.slug,
      unit_price: EXAMPLE_LISTING.unit_price,
      webhook_url: "https://hooks.example.com/registration",
    },
  });

  test("buildWebhookPayload output matches the documented example", async () => {
    const payload = await buildWebhookPayload(
      [exampleEntry()],
      EXAMPLE_CURRENCY,
    );

    expect(payload).toEqual(WEBHOOK_EXAMPLE_PAYLOAD);
  });

  test("WEBHOOK_EXAMPLE_JSON is the pretty-printed payload", () => {
    const formatted = JSON.stringify(WEBHOOK_EXAMPLE_PAYLOAD, null, 2);

    expect(WEBHOOK_EXAMPLE_JSON).toBe(formatted);
  });

  test("example payload has all WebhookPayload keys", async () => {
    const payload = await buildWebhookPayload(
      [exampleEntry()],
      EXAMPLE_CURRENCY,
    );

    const payloadKeys = Object.keys(payload).sort();
    const exampleKeys = Object.keys(WEBHOOK_EXAMPLE_PAYLOAD).sort();

    expect(exampleKeys).toEqual(payloadKeys);
  });

  test("example ticket has all WebhookTicket keys", async () => {
    const payload = await buildWebhookPayload(
      [exampleEntry()],
      EXAMPLE_CURRENCY,
    );

    const ticketKeys = Object.keys(payload.tickets[0]!).sort();
    const exampleTicketKeys = Object.keys(
      WEBHOOK_EXAMPLE_PAYLOAD.tickets[0]!,
    ).sort();

    expect(exampleTicketKeys).toEqual(ticketKeys);
  });

  test("README.md contains the example JSON", async () => {
    const readme = await Deno.readTextFile("README.md");

    expect(readme).toContain(WEBHOOK_EXAMPLE_JSON);
  });
});
