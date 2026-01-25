import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";
import {
  notifyWebhook,
  sendRegistrationWebhook,
  type WebhookPayload,
} from "#lib/webhook.ts";

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

  describe("sendRegistrationWebhook", () => {
    test("sends POST request with correct payload", async () => {
      const webhookUrl = "https://example.com/webhook";
      const eventId = 1;
      const eventSlug = "test-event";
      const attendeeId = 42;
      const quantity = 2;
      const maxAttendees = 100;
      const attendeeCount = 50;

      await sendRegistrationWebhook(
        webhookUrl,
        eventId,
        eventSlug,
        attendeeId,
        quantity,
        maxAttendees,
        attendeeCount,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(webhookUrl);
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const payload = JSON.parse(options.body as string) as WebhookPayload;
      expect(payload.event_type).toBe("attendee.registered");
      expect(payload.event_id).toBe(eventId);
      expect(payload.event_slug).toBe(eventSlug);
      expect(payload.remaining_places).toBe(48); // 100 - 50 - 2
      expect(payload.total_places).toBe(100);
      expect(payload.attendee.id).toBe(attendeeId);
      expect(payload.attendee.quantity).toBe(quantity);
      expect(payload.timestamp).toBeDefined();
    });

    test("does not throw on fetch error", async () => {
      fetchSpy.mockRejectedValue(new Error("Network error"));

      // Should not throw
      await sendRegistrationWebhook(
        "https://example.com/webhook",
        1,
        "test-event",
        42,
        1,
        100,
        50,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("notifyWebhook", () => {
    test("sends webhook when webhook_url is configured", async () => {
      const event = {
        id: 1,
        slug: "test-event",
        webhook_url: "https://example.com/hook",
        max_attendees: 100,
        attendee_count: 10,
      };
      const attendee = {
        id: 99,
        quantity: 1,
      };

      await notifyWebhook(event, attendee);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://example.com/hook");
    });

    test("does nothing when webhook_url is null", async () => {
      const event = {
        id: 1,
        slug: "test-event",
        webhook_url: null,
        max_attendees: 100,
        attendee_count: 10,
      };
      const attendee = {
        id: 99,
        quantity: 1,
      };

      await notifyWebhook(event, attendee);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    test("passes correct attendee data to webhook", async () => {
      const event = {
        id: 42,
        slug: "big-conference",
        webhook_url: "https://webhook.site/test",
        max_attendees: 200,
        attendee_count: 50,
      };
      const attendee = {
        id: 123,
        quantity: 3,
      };

      await notifyWebhook(event, attendee);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const payload = JSON.parse(options.body as string) as WebhookPayload;

      expect(payload.event_id).toBe(42);
      expect(payload.event_slug).toBe("big-conference");
      expect(payload.remaining_places).toBe(147); // 200 - 50 - 3
      expect(payload.total_places).toBe(200);
      expect(payload.attendee.id).toBe(123);
      expect(payload.attendee.quantity).toBe(3);
    });
  });
});
