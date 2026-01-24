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
      const eventName = "Test Event";
      const attendeeId = 42;
      const quantity = 2;

      await sendRegistrationWebhook(
        webhookUrl,
        eventId,
        eventName,
        attendeeId,
        quantity,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(webhookUrl);
      expect(options.method).toBe("POST");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const payload = JSON.parse(options.body as string) as WebhookPayload;
      expect(payload.event_type).toBe("attendee.registered");
      expect(payload.event_id).toBe(eventId);
      expect(payload.event_name).toBe(eventName);
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
        "Test Event",
        42,
        1,
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("notifyWebhook", () => {
    test("sends webhook when webhook_url is configured", async () => {
      const event = {
        id: 1,
        name: "Test Event",
        webhook_url: "https://example.com/hook",
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
        name: "Test Event",
        webhook_url: null,
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
        name: "Big Conference",
        webhook_url: "https://webhook.site/test",
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
      expect(payload.event_name).toBe("Big Conference");
      expect(payload.attendee.id).toBe(123);
      expect(payload.attendee.quantity).toBe(3);
    });
  });
});
