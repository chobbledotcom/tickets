/**
 * Posting a payload: the direct request made and its typed delivery result.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
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

  for (const status of [301, 302, 303, 307, 308]) {
    test(`treats ${status} as failed without disclosing attendee data`, async () => {
      const redirectedUrl = "https://hooks.example.org/privacy-target";
      const privacySentinel = `PRIVATE-ATTENDEE-${status}`;
      let redirectedBody: BodyInit | null = null;
      fetchSpy.reply((url, init) => {
        if (url === redirectedUrl) {
          redirectedBody = init?.body ?? null;
          return new Response();
        }
        if (init?.redirect !== "manual") {
          throw new Error('Webhook request must use redirect: "manual"');
        }
        return new Response("", {
          headers: { location: redirectedUrl },
          status,
        });
      });
      const payload = await buildWebhookPayload(
        defaultEntries().map((entry) => ({
          ...entry,
          attendee: {
            ...entry.attendee,
            special_instructions: privacySentinel,
          },
        })),
        "GBP",
      );

      const result = await sendWebhook("https://example.com/webhook", payload);

      expect(result).toEqual({ delivered: false, reason: "rejected" });
      expect(fetchSpy.calls.length).toBe(1);
      const [firstUrl, firstOptions] = fetchSpy.calls[0]!.args as [
        string,
        RequestInit,
      ];
      expect(firstUrl).toBe("https://example.com/webhook");
      expect(firstOptions.redirect).toBe("manual");
      expect(firstOptions.body).toContain(privacySentinel);
      expect(redirectedBody).toBeNull();
    });
  }

  test("returns a failed delivery on a transport error", async () => {
    fetchSpy.reply(() => Promise.reject(new TypeError("Network error")));

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    const result = await sendWebhook("https://example.com/webhook", payload);

    expect(result).toEqual({ delivered: false, reason: "transport" });
    expect(fetchSpy.calls.length).toBe(1);
  });

  test("returns a failed delivery when the endpoint stalls", async () => {
    using time = new FakeTime();
    fetchSpy.reply(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
    );
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    const sending = sendWebhook("https://example.com/webhook", payload);
    await time.tickAsync(10_000);

    expect(await sending).toEqual({ delivered: false, reason: "transport" });
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
    fetchSpy.reply(() =>
      Promise.reject(new TypeError("secret transport detail")),
    );
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    const logs = await withErrorSpy(async (errorSpy) => {
      await sendWebhook("https://example.com/webhook", payload);
      return errorSpy.calls;
    });

    expect(logs).toEqual([]);
  });

  test("does not hide a subrequest allowance failure", async () => {
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    await expect(
      runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 0, external: 0, total: 0 }, () =>
          sendWebhook("https://example.com/webhook", payload),
        ),
      ),
    ).rejects.toThrow(
      "Subrequest allowance exceeded: 0 database + 1 external calls",
    );
    expect(fetchSpy.calls.length).toBe(0);
  });
});
