import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import {
  buildWebhookPayload,
  type RegistrationEntry,
  sendRegistrationWebhooks,
  sendWebhook,
  type WebhookAttendee,
  type WebhookEvent,
  type WebhookPayload,
} from "#lib/webhook.ts";
import { createTestDbWithSetup, createTestEvent, resetDb } from "#test-utils";

/** Helper to build a WebhookEvent with sensible defaults */
const makeEvent = (overrides: Partial<WebhookEvent> = {}): WebhookEvent => ({
  id: 1,
  name: "Test Event",
  slug: "test-event",
  webhook_url: "https://example.com/webhook",
  max_attendees: 100,
  attendee_count: 10,
  unit_price: null,
  ...overrides,
});

/** Helper to build a WebhookAttendee with sensible defaults */
const makeAttendee = (overrides: Partial<WebhookAttendee> = {}): WebhookAttendee => ({
  id: 42,
  quantity: 1,
  name: "Jane Doe",
  email: "jane@example.com",
  phone: "555-1234",
  ticket_token: "test-token-42",
  ...overrides,
});

describe("webhook", () => {
  // deno-lint-ignore no-explicit-any
  let fetchSpy: any;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  describe("buildWebhookPayload", () => {
    test("builds payload for a single free event", () => {
      const entries: RegistrationEntry[] = [
        { event: makeEvent(), attendee: makeAttendee() },
      ];

      const payload = buildWebhookPayload(entries, "GBP");

      expect(payload.event_type).toBe("registration.completed");
      expect(payload.name).toBe("Jane Doe");
      expect(payload.email).toBe("jane@example.com");
      expect(payload.phone).toBe("555-1234");
      expect(payload.price_paid).toBeNull();
      expect(payload.currency).toBe("GBP");
      expect(payload.payment_id).toBeNull();
      expect(payload.ticket_url).toBe("https://localhost/t/test-token-42");
      expect(payload.tickets).toHaveLength(1);
      expect(payload.tickets[0]!.event_name).toBe("Test Event");
      expect(payload.tickets[0]!.event_slug).toBe("test-event");
      expect(payload.tickets[0]!.unit_price).toBeNull();
      expect(payload.tickets[0]!.quantity).toBe(1);
      expect(payload.timestamp).toBeDefined();
    });

    test("builds payload for a single paid event with price_paid on attendee", () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ unit_price: 500 }),
          attendee: makeAttendee({
            quantity: 2,
            price_paid: "1000",
            payment_id: "pi_abc123",
          }),
        },
      ];

      const payload = buildWebhookPayload(entries, "USD");

      expect(payload.price_paid).toBe(1000);
      expect(payload.payment_id).toBe("pi_abc123");
      expect(payload.currency).toBe("USD");
      expect(payload.tickets[0]!.unit_price).toBe(500);
      expect(payload.tickets[0]!.quantity).toBe(2);
    });

    test("builds payload for multi-event entries", () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ id: 1, name: "Event A", slug: "event-a", unit_price: 300 }),
          attendee: makeAttendee({ ticket_token: "tok-a", price_paid: "300", payment_id: "pi_multi" }),
        },
        {
          event: makeEvent({ id: 2, name: "Event B", slug: "event-b", unit_price: 700 }),
          attendee: makeAttendee({ ticket_token: "tok-b", quantity: 2, price_paid: "1400", payment_id: "pi_multi" }),
        },
      ];

      const payload = buildWebhookPayload(entries, "EUR");

      expect(payload.name).toBe("Jane Doe");
      expect(payload.price_paid).toBe(1700);
      expect(payload.payment_id).toBe("pi_multi");
      expect(payload.ticket_url).toBe("https://localhost/t/tok-a+tok-b");
      expect(payload.tickets).toHaveLength(2);
      expect(payload.tickets[0]!.event_name).toBe("Event A");
      expect(payload.tickets[0]!.unit_price).toBe(300);
      expect(payload.tickets[1]!.event_name).toBe("Event B");
      expect(payload.tickets[1]!.unit_price).toBe(700);
      expect(payload.tickets[1]!.quantity).toBe(2);
    });

    test("returns 0 price_paid when attendee has no price_paid on paid event", () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ unit_price: 500 }),
          attendee: makeAttendee({ quantity: 3 }),
        },
      ];

      const payload = buildWebhookPayload(entries, "GBP");

      expect(payload.price_paid).toBe(0);
    });
  });

  describe("sendWebhook", () => {
    test("sends POST request with correct payload", async () => {
      const payload: WebhookPayload = buildWebhookPayload(
        [{ event: makeEvent(), attendee: makeAttendee() }],
        "GBP",
      );

      await sendWebhook("https://example.com/webhook", payload);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.com/webhook");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.event_type).toBe("registration.completed");
      expect(body.name).toBe("Jane Doe");
      expect(body.tickets).toHaveLength(1);
    });

    test("does not throw on fetch error", async () => {
      fetchSpy.mockRejectedValue(new Error("Network error"));

      const payload = buildWebhookPayload(
        [{ event: makeEvent(), attendee: makeAttendee() }],
        "GBP",
      );

      // Should not throw
      await sendWebhook("https://example.com/webhook", payload);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendRegistrationWebhooks", () => {
    test("sends to all unique webhook URLs", async () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ id: 1, webhook_url: "https://hook-a.com" }),
          attendee: makeAttendee(),
        },
        {
          event: makeEvent({ id: 2, webhook_url: "https://hook-b.com" }),
          attendee: makeAttendee(),
        },
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const urls = fetchSpy.mock.calls.map(
        (call: [string, RequestInit]) => call[0],
      );
      expect(urls).toContain("https://hook-a.com");
      expect(urls).toContain("https://hook-b.com");
    });

    test("deduplicates identical webhook URLs", async () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ id: 1, webhook_url: "https://same-hook.com" }),
          attendee: makeAttendee(),
        },
        {
          event: makeEvent({ id: 2, webhook_url: "https://same-hook.com" }),
          attendee: makeAttendee(),
        },
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    test("skips entries with null webhook URLs", async () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ id: 1, webhook_url: null }),
          attendee: makeAttendee(),
        },
        {
          event: makeEvent({ id: 2, webhook_url: "https://hook.com" }),
          attendee: makeAttendee(),
        },
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://hook.com");
    });

    test("does nothing when all webhook URLs are null", async () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ webhook_url: null }),
          attendee: makeAttendee(),
        },
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("logAndNotifyRegistration", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    afterEach(() => {
      resetDb();
    });

    test("sends webhook when event has webhook_url", async () => {
      const { logAndNotifyRegistration } = await import("#lib/webhook.ts");
      const dbEvent = await createTestEvent({ webhookUrl: "https://example.com/hook" });
      const event = makeEvent({
        id: dbEvent.id,
        name: dbEvent.name,
        slug: dbEvent.slug,
        webhook_url: "https://example.com/hook",
      });
      const attendee = makeAttendee();

      await logAndNotifyRegistration(event, attendee, "GBP");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.com/hook");
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.event_type).toBe("registration.completed");
      expect(body.name).toBe("Jane Doe");
    });

    test("does not send webhook when event has no webhook_url", async () => {
      const { logAndNotifyRegistration } = await import("#lib/webhook.ts");
      const dbEvent = await createTestEvent();
      const event = makeEvent({
        id: dbEvent.id,
        name: dbEvent.name,
        slug: dbEvent.slug,
        webhook_url: null,
      });
      const attendee = makeAttendee();

      await logAndNotifyRegistration(event, attendee, "GBP");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("logAndNotifyMultiRegistration", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    afterEach(() => {
      resetDb();
    });

    test("sends webhooks for multi-event registration", async () => {
      const { logAndNotifyMultiRegistration } = await import("#lib/webhook.ts");
      const dbEventA = await createTestEvent({ webhookUrl: "https://hook.com" });
      const dbEventB = await createTestEvent({ webhookUrl: "https://hook.com" });
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({
            id: dbEventA.id,
            name: dbEventA.name,
            slug: dbEventA.slug,
            webhook_url: "https://hook.com",
          }),
          attendee: makeAttendee(),
        },
        {
          event: makeEvent({
            id: dbEventB.id,
            name: dbEventB.name,
            slug: dbEventB.slug,
            webhook_url: "https://hook.com",
          }),
          attendee: makeAttendee(),
        },
      ];

      await logAndNotifyMultiRegistration(entries, "GBP");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.tickets).toHaveLength(2);
    });

    test("does not send webhook when no events have webhook URLs", async () => {
      const { logAndNotifyMultiRegistration } = await import("#lib/webhook.ts");
      const dbEventA = await createTestEvent();
      const dbEventB = await createTestEvent();
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ id: dbEventA.id, webhook_url: null }),
          attendee: makeAttendee(),
        },
        {
          event: makeEvent({ id: dbEventB.id, webhook_url: null }),
          attendee: makeAttendee(),
        },
      ];

      await logAndNotifyMultiRegistration(entries, "USD");

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
