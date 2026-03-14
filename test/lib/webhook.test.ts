import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { bracket, map } from "#fp";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import {
  buildWebhookPayload,
  type RegistrationEntry,
  sendRegistrationWebhooks,
  sendWebhook,
  type WebhookAttendee,
  type WebhookEvent,
  type WebhookPayload,
} from "#lib/webhook.ts";
import {
  createTestDbWithSetup,
  createTestEvent,
  type EmailEntry,
  type EmailEvent,
  makeTestAttendee as makeAttendee,
  makeTestEntry as makeEntry,
  makeTestEvent as makeEvent,
  resetDb,
} from "#test-utils";

/** Default single-entry registration (free event, default attendee) */
const defaultEntries = (): EmailEntry[] => [makeEntry()];

/** Extract first arg (as string) from each spy call */
const spyFirstArgs = map((c: { args: unknown[] }) => c.args[0] as string);

/** Bracket-managed console.error spy — auto-restores on completion */
const withErrorSpy = bracket(
  () => spy(console, "error"),
  (s: { restore: () => void }) => s.restore(),
);

/** Convert a db event + webhook_url into makeEvent overrides */
const eventFromDb = (
  { id, name, slug }: { id: number; name: string; slug: string },
  webhook_url: string,
): Partial<WebhookEvent> => ({ id, name, slug, webhook_url });

/** Flush pending async operations (fire-and-forget webhooks) */
const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("webhook", () => {
  // deno-lint-ignore no-explicit-any
  let fetchSpy: any;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = stub(globalThis, "fetch", () => Promise.resolve(new Response()));
  });

  afterEach(() => {
    fetchSpy.restore();
    globalThis.fetch = originalFetch;
  });

  /** Restore current fetch stub and replace with a custom implementation */
  const restubFetch = (impl: () => Promise<Response>): void => {
    fetchSpy.restore();
    fetchSpy = stub(globalThis, "fetch", impl);
  };

  /** Drain floating async logError promises, then reset and recreate the test DB */
  const drainAndResetDb = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    resetDb();
    await createTestDbWithSetup();
  };

  /** Restub fetch, send a webhook with default payload, return collected error logs */
  const sendAndCollectErrors = (
    fetchImpl: () => Promise<Response>,
  ): Promise<string[]> =>
    withErrorSpy(async (errorSpy) => {
      restubFetch(fetchImpl);
      const payload = await buildWebhookPayload(defaultEntries(), "GBP");
      await sendWebhook("https://example.com/webhook", payload);
      return spyFirstArgs(errorSpy.calls);
    });

  describe("buildWebhookPayload", () => {
    beforeEach(async () => {
      const { invalidateSettingsCache } = await import("#lib/db/settings.ts");
      await resetDb();
      await createTestDbWithSetup();
      invalidateSettingsCache();
    });

    test("builds payload for a single free event", async () => {
      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      expect(payload.event_type).toBe("registration.completed");
      expect(payload.name).toBe("Jane Doe");
      expect(payload.email).toBe("jane@example.com");
      expect(payload.phone).toBe("555-1234");
      expect(payload.price_paid).toBeNull();
      expect(payload.currency).toBe("GBP");
      expect(payload.payment_id).toBeNull();
      expect(payload.ticket_url).toBe("https://localhost/t/AABB001122");
      expect(payload.tickets).toHaveLength(1);
      expect(payload.tickets[0]!.event_name).toBe("Test Event");
      expect(payload.tickets[0]!.event_slug).toBe("test-event");
      expect(payload.tickets[0]!.unit_price).toBe(0);
      expect(payload.tickets[0]!.quantity).toBe(1);
      expect(payload.tickets[0]!.date).toBeNull();
      expect(payload.tickets[0]!.ticket_token).toBe("AABB001122");
      expect(payload.timestamp).toBeDefined();
      expect(payload.business_email).toBe("");
    });

    test("builds payload for a single paid event with price_paid on attendee", async () => {
      const entries = [
        makeEntry(
          { unit_price: 500 },
          { quantity: 2, price_paid: "1000", payment_id: "pi_abc123" },
        ),
      ];

      const payload = await buildWebhookPayload(entries, "USD");

      expect(payload.price_paid).toBe(1000);
      expect(payload.payment_id).toBe("pi_abc123");
      expect(payload.currency).toBe("USD");
      expect(payload.tickets[0]!.unit_price).toBe(500);
      expect(payload.tickets[0]!.quantity).toBe(2);
    });

    test("builds payload for multi-event entries", async () => {
      const entries = [
        makeEntry(
          { id: 1, name: "Event A", slug: "event-a", unit_price: 300 },
          {
            ticket_token: "AA00BB11CC",
            price_paid: "300",
            payment_id: "pi_multi",
          },
        ),
        makeEntry(
          { id: 2, name: "Event B", slug: "event-b", unit_price: 700 },
          {
            ticket_token: "DD22EE33FF",
            quantity: 2,
            price_paid: "1400",
            payment_id: "pi_multi",
          },
        ),
      ];

      const payload = await buildWebhookPayload(entries, "EUR");

      expect(payload.name).toBe("Jane Doe");
      expect(payload.price_paid).toBe(1700);
      expect(payload.payment_id).toBe("pi_multi");
      expect(payload.ticket_url).toBe(
        "https://localhost/t/AA00BB11CC+DD22EE33FF",
      );
      expect(payload.tickets).toHaveLength(2);
      expect(payload.tickets[0]!.event_name).toBe("Event A");
      expect(payload.tickets[0]!.unit_price).toBe(300);
      expect(payload.tickets[0]!.ticket_token).toBe("AA00BB11CC");
      expect(payload.tickets[1]!.event_name).toBe("Event B");
      expect(payload.tickets[1]!.unit_price).toBe(700);
      expect(payload.tickets[1]!.quantity).toBe(2);
      expect(payload.tickets[1]!.ticket_token).toBe("DD22EE33FF");
    });

    test("includes price_paid for free can_pay_more event where attendee paid", async () => {
      const entries: RegistrationEntry[] = [
        {
          event: makeEvent({ unit_price: 0, can_pay_more: true }),
          attendee: makeAttendee({
            price_paid: "500",
            payment_id: "pi_donate",
          }),
        },
      ];

      const payload = await buildWebhookPayload(entries, "GBP");

      expect(payload.price_paid).toBe(500);
      expect(payload.payment_id).toBe("pi_donate");
    });

    test("includes date in ticket when attendee has a date", async () => {
      const payload = await buildWebhookPayload(
        [makeEntry({}, { date: "2025-07-15" })],
        "GBP",
      );

      expect(payload.tickets[0]!.date).toBe("2025-07-15");
    });

    test("includes mixed dates for multi-event with daily and standard events", async () => {
      const entries = [
        makeEntry(
          { id: 1, name: "Daily Event", slug: "daily-event" },
          { ticket_token: "AA00BB11CC", date: "2025-07-15" },
        ),
        makeEntry(
          { id: 2, name: "Standard Event", slug: "standard-event" },
          { ticket_token: "DD22EE33FF", date: null },
        ),
      ];

      const payload = await buildWebhookPayload(entries, "GBP");

      expect(payload.tickets[0]!.date).toBe("2025-07-15");
      expect(payload.tickets[1]!.date).toBeNull();
    });

    test("returns 0 price_paid when attendee has no price_paid on paid event", async () => {
      const payload = await buildWebhookPayload(
        [makeEntry({ unit_price: 500 }, { quantity: 3 })],
        "GBP",
      );

      expect(payload.price_paid).toBe(0);
    });

    test("includes business_email when set", async () => {
      const { updateBusinessEmail } = await import("#lib/business-email.ts");
      await updateBusinessEmail("contact@example.com");

      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      expect(payload.business_email).toBe("contact@example.com");
    });

    test("includes empty business_email when not set", async () => {
      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      expect(payload.business_email).toBe("");
    });
  });

  describe("sendWebhook", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    afterEach(() => {
      resetDb();
    });

    test("sends POST request with correct payload", async () => {
      const payload: WebhookPayload = await buildWebhookPayload(
        defaultEntries(),
        "GBP",
      );

      await sendWebhook("https://example.com/webhook", payload);

      expect(fetchSpy.calls.length).toBe(1);
      const [url, options] = fetchSpy.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://example.com/webhook");
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.event_type).toBe("registration.completed");
      expect(body.name).toBe("Jane Doe");
      expect(body.tickets).toHaveLength(1);
    });

    test("does not throw on fetch error", async () => {
      restubFetch(() => Promise.reject(new Error("Network error")));

      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      // Should not throw
      await sendWebhook("https://example.com/webhook", payload);

      expect(fetchSpy.calls.length).toBe(1);
    });

    test("logs error message on fetch error", async () => {
      const logs = await sendAndCollectErrors(() =>
        Promise.reject(new Error("Connection refused")),
      );
      expect(
        logs.some(
          (c) =>
            c.includes("E_WEBHOOK_SEND") && c.includes("Connection refused"),
        ),
      ).toBe(true);
    });

    test("logs non-Error thrown values as strings", async () => {
      const logs = await sendAndCollectErrors(() =>
        Promise.reject("socket hang up"),
      );
      expect(
        logs.some(
          (c) => c.includes("E_WEBHOOK_SEND") && c.includes("socket hang up"),
        ),
      ).toBe(true);
    });

    test("logs status on non-2xx response", async () => {
      const logs = await sendAndCollectErrors(() =>
        Promise.resolve(new Response("Not Found", { status: 404 })),
      );
      expect(
        logs.some(
          (c) => c.includes("E_WEBHOOK_SEND") && c.includes("status=404"),
        ),
      ).toBe(true);
    });

    test("does not log error on successful 2xx response", async () => {
      const logs = await sendAndCollectErrors(() =>
        Promise.resolve(new Response("OK", { status: 200 })),
      );
      expect(logs.some((c) => c.includes("E_WEBHOOK_SEND"))).toBe(false);
    });

    test("logs activity on non-2xx response", async () => {
      await drainAndResetDb();

      await withErrorSpy(async () => {
        restubFetch(() =>
          Promise.resolve(new Response("Bad Gateway", { status: 502 })),
        );
        const payload = await buildWebhookPayload(defaultEntries(), "GBP");
        await sendWebhook("https://example.com/webhook", payload);
      });
      // Wait for pending logError→logActivity to flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      const entries = await getAllActivityLog();
      const match = entries.find(
        (e) =>
          e.message ===
          "Error: Webhook send failed (status=502 for 'Test Event')",
      );
      expect(match).toBeDefined();
    });

    test("does not log activity on successful response", async () => {
      await drainAndResetDb();

      const payload = await buildWebhookPayload(defaultEntries(), "GBP");
      await sendWebhook("https://example.com/webhook", payload);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const entries = await getAllActivityLog();
      const errorEntries = entries.filter((e) =>
        e.message.startsWith("Error:"),
      );
      expect(errorEntries).toHaveLength(0);
    });

    test("logs comma-separated event names for multi-event payload", async () => {
      await drainAndResetDb();

      await withErrorSpy(async () => {
        restubFetch(() =>
          Promise.resolve(new Response("Error", { status: 500 })),
        );
        const entries: RegistrationEntry[] = [
          makeEntry(
            { id: 1, name: "Event A", slug: "event-a" },
            { ticket_token: "AA11BB22CC" },
          ),
          makeEntry(
            { id: 2, name: "Event B", slug: "event-b" },
            { ticket_token: "DD33EE44FF" },
          ),
        ];
        const payload = await buildWebhookPayload(entries, "GBP");
        await sendWebhook("https://example.com/webhook", payload);
      });
      // Wait for pending logError→logActivity to flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      const entries = await getAllActivityLog();
      const match = entries.find(
        (e) =>
          e.message ===
          "Error: Webhook send failed (status=500 for 'Event A, Event B')",
      );
      expect(match).toBeDefined();
    });
  });

  describe("sendRegistrationWebhooks", () => {
    beforeEach(async () => {
      await createTestDbWithSetup();
    });

    afterEach(() => {
      resetDb();
    });

    test("sends to all unique webhook URLs", async () => {
      const entries = [
        makeEntry({ id: 1, webhook_url: "https://hook-a.com" }),
        makeEntry({ id: 2, webhook_url: "https://hook-b.com" }),
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy.calls.length).toBe(2);
      const urls = spyFirstArgs(fetchSpy.calls);
      expect(urls).toContain("https://hook-a.com");
      expect(urls).toContain("https://hook-b.com");
    });

    test("deduplicates identical webhook URLs", async () => {
      const entries = [
        makeEntry({ id: 1, webhook_url: "https://same-hook.com" }),
        makeEntry({ id: 2, webhook_url: "https://same-hook.com" }),
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy.calls.length).toBe(1);
    });

    test("skips entries with empty webhook URLs", async () => {
      const entries = [
        makeEntry({ id: 1, webhook_url: "" }),
        makeEntry({ id: 2, webhook_url: "https://hook.com" }),
      ];

      await sendRegistrationWebhooks(entries, "GBP");

      expect(fetchSpy.calls.length).toBe(1);
      const [url] = fetchSpy.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://hook.com");
    });

    test("does nothing when all webhook URLs are empty", async () => {
      await sendRegistrationWebhooks([makeEntry({ webhook_url: "" })], "GBP");

      expect(fetchSpy.calls.length).toBe(0);
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
      const dbEvent = await createTestEvent({
        webhookUrl: "https://example.com/hook",
      });
      const event = makeEvent(eventFromDb(dbEvent, "https://example.com/hook"));

      await logAndNotifyRegistration(event, makeAttendee(), "GBP");
      await flushAsync();

      expect(fetchSpy.calls.length).toBe(1);
      const [url, options] = fetchSpy.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://example.com/hook");
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.event_type).toBe("registration.completed");
      expect(body.name).toBe("Jane Doe");
    });

    test("does not send webhook when event has no webhook_url", async () => {
      const { logAndNotifyRegistration } = await import("#lib/webhook.ts");
      const dbEvent = await createTestEvent();
      const event = makeEvent(eventFromDb(dbEvent, ""));

      await logAndNotifyRegistration(event, makeAttendee(), "GBP");
      await flushAsync();

      expect(fetchSpy.calls.length).toBe(0);
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
      const dbEventA = await createTestEvent({
        webhookUrl: "https://hook.com",
      });
      const dbEventB = await createTestEvent({
        webhookUrl: "https://hook.com",
      });
      const entries = [
        makeEntry(eventFromDb(dbEventA, "https://hook.com")),
        makeEntry(eventFromDb(dbEventB, "https://hook.com")),
      ];

      await logAndNotifyMultiRegistration(entries, "GBP");
      await flushAsync();

      expect(fetchSpy.calls.length).toBe(1);
      const [, options] = fetchSpy.calls[0].args as [string, RequestInit];
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.tickets).toHaveLength(2);
    });

    test("does not send webhook when no events have webhook URLs", async () => {
      const { logAndNotifyMultiRegistration } = await import("#lib/webhook.ts");
      const dbEventA = await createTestEvent();
      const dbEventB = await createTestEvent();
      const entries = [
        makeEntry(eventFromDb(dbEventA, "")),
        makeEntry(eventFromDb(dbEventB, "")),
      ];

      await logAndNotifyMultiRegistration(entries, "USD");
      await flushAsync();

      expect(fetchSpy.calls.length).toBe(0);
    });
  });
});
