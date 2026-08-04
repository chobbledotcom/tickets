/**
 * Posting a payload: the request made, the redirects followed or refused, and
 * what is said when the other end does not accept it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  buildWebhookPayload,
  type RegistrationEntry,
  sendWebhook,
  type WebhookPayload,
} from "#shared/webhook.ts";
import {
  defaultEntries,
  drainAndResetDb,
  sendAndCollectErrors,
  sendWebhookAndGetActivityLog,
  stubWebhookFetch,
} from "#test/shared/webhook/helpers.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";

describeWithEnv("sendWebhook", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

  test("sends POST request with correct payload", async () => {
    const payload: WebhookPayload = await buildWebhookPayload(
      defaultEntries(),
      "GBP",
    );

    await sendWebhook("https://example.com/webhook", payload);

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

  test("follows a safe redirect with each hop validated manually", async () => {
    let count = 0;
    fetchSpy.reply(() => {
      count++;
      return Promise.resolve(
        count === 1
          ? new Response("", {
              headers: { location: "https://hooks.example.org/final" },
              status: 307,
            })
          : new Response("ok"),
      );
    });

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    await sendWebhook("https://example.com/webhook", payload);

    expect(fetchSpy.calls.length).toBe(2);
    const [firstUrl, firstOptions] = fetchSpy.calls[0]!.args as [
      string,
      RequestInit,
    ];
    const [secondUrl, secondOptions] = fetchSpy.calls[1]!.args as [
      string,
      RequestInit,
    ];
    expect(firstUrl).toBe("https://example.com/webhook");
    expect(firstOptions.redirect).toBe("manual");
    expect(secondUrl).toBe("https://hooks.example.org/final");
    expect(secondOptions.redirect).toBe("manual");
  });

  test("refuses to follow an unsafe redirect target", async () => {
    fetchSpy.reply(() =>
      Promise.resolve(
        new Response("", {
          headers: { location: "https://127.0.0.1/final" },
          status: 307,
        }),
      ),
    );

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    await sendWebhook("https://example.com/webhook", payload);

    expect(fetchSpy.calls.length).toBe(1);
  });

  test("does not throw on fetch error", async () => {
    fetchSpy.reply(() => Promise.reject(new Error("Network error")));

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    // Should not throw
    await sendWebhook("https://example.com/webhook", payload);

    expect(fetchSpy.calls.length).toBe(1);
  });

  test("refuses to fetch an unsafe (internal) webhook URL", async () => {
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");

    // SSRF guard: an internal/non-https URL must never be fetched.
    await sendWebhook("http://169.254.169.254/latest/meta-data", payload);

    expect(fetchSpy.calls.length).toBe(0);
  });

  test("logs error message on fetch error", async () => {
    const logs = await sendAndCollectErrors(fetchSpy, () =>
      Promise.reject(new Error("Connection refused")),
    );
    expect(
      logs.some(
        (c) => c.includes("E_WEBHOOK_SEND") && c.includes("Connection refused"),
      ),
    ).toBe(true);
  });

  test("logs non-Error thrown values as strings", async () => {
    const logs = await sendAndCollectErrors(fetchSpy, () =>
      Promise.reject("socket hang up"),
    );
    expect(
      logs.some(
        (c) => c.includes("E_WEBHOOK_SEND") && c.includes("socket hang up"),
      ),
    ).toBe(true);
  });

  test("logs status on non-2xx response", async () => {
    const logs = await sendAndCollectErrors(fetchSpy, () =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    );
    expect(
      logs.some(
        (c) => c.includes("E_WEBHOOK_SEND") && c.includes("status=404"),
      ),
    ).toBe(true);
  });

  test("does not log error on successful 2xx response", async () => {
    const logs = await sendAndCollectErrors(fetchSpy, () =>
      Promise.resolve(new Response("OK", { status: 200 })),
    );
    expect(logs.some((c) => c.includes("E_WEBHOOK_SEND"))).toBe(false);
  });

  const expectWebhookActivityError = async (
    status: number,
    expectedMessage: string,
    registrationEntries?: RegistrationEntry[],
  ) => {
    const logEntries = await sendWebhookAndGetActivityLog(
      fetchSpy,
      status,
      registrationEntries,
    );
    expect(logEntries.find((e) => e.message === expectedMessage)).toBeDefined();
  };

  test("logs activity on non-2xx response", async () => {
    await drainAndResetDb();

    await expectWebhookActivityError(
      502,
      "Error: Webhook send failed (status=502 for 'Test Listing')",
    );
  });

  test("does not log activity on successful response", async () => {
    await drainAndResetDb();

    const payload = await buildWebhookPayload(defaultEntries(), "GBP");
    await sendWebhook("https://example.com/webhook", payload);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = await getAllActivityLog();
    const errorEntries = entries.filter((e) => e.message.startsWith("Error:"));
    expect(errorEntries).toHaveLength(0);
  });

  test("logs comma-separated listing names for multi-listing payload", async () => {
    await drainAndResetDb();

    const multiEntries: RegistrationEntry[] = [
      makeEntry(
        { id: 1, name: "Listing A", slug: "listing-a" },
        { ticket_token: "AA11BB22CC" },
      ),
      makeEntry(
        { id: 2, name: "Listing B", slug: "listing-b" },
        { ticket_token: "DD33EE44FF" },
      ),
    ];
    await expectWebhookActivityError(
      500,
      "Error: Webhook send failed (status=500 for 'Listing A, Listing B')",
      multiEntries,
    );
  });
});
