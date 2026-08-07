/**
 * Posting a payload: the direct request made and its typed delivery result.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildWebhookPayload,
  sendWebhook,
  type WebhookPayload,
} from "#shared/webhook.ts";
import {
  defaultEntries,
  stubWebhookFetch,
  withErrorSpy,
} from "#test/shared/webhook/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("sendWebhook", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

  test("sends POST request with correct payload", async () => {
    const payload: WebhookPayload = await buildWebhookPayload(
      defaultEntries(),
      "GBP",
    );

    const result = await sendWebhook("https://example.com/webhook", payload);

    expect(result).toEqual({ delivered: true });
    expect(fetchSpy.calls.length).toBe(1);
    const [url, options] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.com/webhook");
    expect(options.method).toBe("POST");
    expect(options.redirect).toBe("manual");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });

    const body = JSON.parse(options.body as string) as WebhookPayload;
    expect(body.notification_type).toBe("registration.completed");
    expect(body.name).toBe("Jane Doe");
    expect(body.tickets).toHaveLength(1);
  });

  test("treats a redirect as failed without following it", async () => {
    fetchSpy.reply(() =>
      Promise.resolve(
        new Response("", {
          headers: { location: "https://hooks.example.org/final" },
          status: 307,
        }),
      ),
    );

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    const result = await sendWebhook("https://example.com/webhook", payload);

    expect(result).toEqual({ delivered: false, reason: "rejected" });
    expect(fetchSpy.calls.length).toBe(1);
    const [firstUrl, firstOptions] = fetchSpy.calls[0]!.args as [
      string,
      RequestInit,
    ];
    expect(firstUrl).toBe("https://example.com/webhook");
    expect(firstOptions.redirect).toBe("manual");
  });

  test("returns a failed delivery on a transport error", async () => {
    fetchSpy.reply(() => Promise.reject(new Error("Network error")));

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    const result = await sendWebhook("https://example.com/webhook", payload);

    expect(result).toEqual({ delivered: false, reason: "transport" });
    expect(fetchSpy.calls.length).toBe(1);
  });

  test("refuses to fetch an unsafe (internal) webhook URL", async () => {
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    // SSRF guard: an internal/non-https URL must never be fetched.
    const result = await sendWebhook(
      "http://169.254.169.254/latest/meta-data",
      payload,
    );

    expect(result).toEqual({ delivered: false, reason: "unsafe_url" });
    expect(fetchSpy.calls.length).toBe(0);
  });

  test("does not report expected delivery failures as incidents", async () => {
    fetchSpy.reply(() => Promise.reject(new Error("secret transport detail")));
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    const logs = await withErrorSpy(async (errorSpy) => {
      await sendWebhook("https://example.com/webhook", payload);
      return errorSpy.calls;
    });

    expect(logs).toEqual([]);
  });
});
