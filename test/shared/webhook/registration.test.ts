/**
 * Which webhook endpoints a finished booking reaches, and what the site records
 * about it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runWithPendingWork } from "#shared/pending-work.ts";
import {
  logAndNotifyRegistration,
  sendRegistrationWebhooks,
  type WebhookPayload,
} from "#shared/webhook.ts";
import {
  flushAsync,
  listingFromDb,
  spyFirstArgs,
  stubWebhookFetch,
  withErrorSpy,
} from "#test/shared/webhook/helpers.ts";
import {
  activityMessages,
  getAllActivityLog,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import {
  makeTestAttendee as makeAttendee,
  makeTestEntry as makeEntry,
  makeTestListing as makeListing,
} from "#test-utils/factories.ts";

describeWithEnv("sendRegistrationWebhooks", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

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
    const [url] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://hook.com");
  });

  test("does nothing when all webhook URLs are empty", async () => {
    await sendRegistrationWebhooks([makeEntry({ webhook_url: "" })], "GBP");

    expect(fetchSpy.calls.length).toBe(0);
  });

  test("loads package overrides for a package booking's webhook", async () => {
    // A package member (package_group_id > 0) drives the override load; with no
    // override row for the member, its unit_price falls back to the base price.
    const entries = [
      makeEntry(
        { id: 1, unit_price: 900, webhook_url: "https://hook.com" },
        { package_group_id: 5 },
      ),
    ];

    await sendRegistrationWebhooks(entries, "GBP");

    expect(fetchSpy.calls.length).toBe(1);
    expect(fetchSpy.firstBody().tickets[0]!.unit_price).toBe(900);
  });

  test("accepts 16 distinct webhook URLs", async () => {
    const entries = Array.from({ length: 16 }, (_, index) =>
      makeEntry({ id: index + 1, webhook_url: `https://hook-${index}.com` }),
    );

    await sendRegistrationWebhooks(entries, "GBP");

    expect(fetchSpy.calls.length).toBe(16);
  });

  test("rejects 17 distinct webhook URLs before fetching", async () => {
    const entries = Array.from({ length: 17 }, (_, index) =>
      makeEntry({ id: index + 1, webhook_url: `https://hook-${index}.com` }),
    );

    await expect(sendRegistrationWebhooks(entries, "GBP")).rejects.toThrow(
      "Registration webhook URL limit exceeded",
    );
    expect(fetchSpy.calls.length).toBe(0);
    expect(await activityMessages()).toEqual([
      "Registration notification delivery failed",
    ]);
  });

  test("records one value-free activity for all failed deliveries", async () => {
    const sentinels = {
      attendee: "PRIVATE-ATTENDEE-VALUE",
      body: "PRIVATE-BODY-VALUE",
      provider: "PRIVATE-PROVIDER-VALUE",
      url: "private-url-value",
    };
    const entries = [
      makeEntry(
        { id: 1, webhook_url: `https://${sentinels.url}-a.com` },
        { name: sentinels.attendee, special_instructions: sentinels.body },
      ),
      makeEntry({
        id: 2,
        webhook_url: `https://${sentinels.url}-${sentinels.provider}.com`,
      }),
    ];
    fetchSpy.reply(() => new Response("refused", { status: 503 }));

    await sendRegistrationWebhooks(entries, "GBP");

    const messages = await activityMessages();
    expect(messages).toEqual(["Registration notification delivery failed"]);
    for (const value of Object.values(sentinels)) {
      expect(messages.join("\n")).not.toContain(value);
    }
  });

  test("reports an unexpected failure from pending registration work", async () => {
    fetchSpy.reply(() => Promise.reject(new Error("private failure detail")));
    const entries = [
      makeEntry({ webhook_url: "https://private-webhook.example.com" }),
    ];

    const logs = await withErrorSpy(async (errorSpy) => {
      await runWithPendingWork(() => logAndNotifyRegistration(entries));
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("E_WEBHOOK_SEND");
    expect(logs[0]).not.toContain("private");
  });

  test("waits for sibling sends before rejecting an unexpected failure", async () => {
    const slow = Promise.withResolvers<Response>();
    const unexpected = new Error("Unexpected send failure");
    fetchSpy.reply((url) =>
      url === "https://slow-hook.com"
        ? slow.promise
        : Promise.reject(unexpected),
    );
    const entries = [
      makeEntry({ id: 1, webhook_url: "https://failed-hook.com" }),
      makeEntry({ id: 2, webhook_url: "https://slow-hook.com" }),
    ];

    await withErrorSpy(async () => {
      let rejected = false;
      const outcome = Promise.withResolvers<unknown>();
      const sending = (async () => {
        try {
          await sendRegistrationWebhooks(entries, "GBP");
          outcome.resolve(null);
        } catch (error) {
          rejected = true;
          outcome.resolve(error);
        }
      })();
      await flushAsync();
      try {
        expect(rejected).toBe(false);
      } finally {
        slow.resolve(new Response());
        await sending;
      }
      expect(await outcome.promise).toBe(unexpected);
    });
  });
});

describeWithEnv("logAndNotifyRegistration", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

  test("sends webhook when listing has webhook_url", async () => {
    const dbListing = await createTestListing({
      webhookUrl: "https://example.com/hook",
    });
    const listing = makeListing(
      listingFromDb(dbListing, "https://example.com/hook"),
    );

    await logAndNotifyRegistration([{ attendee: makeAttendee(), listing }]);
    await flushAsync();

    expect(fetchSpy.calls.length).toBe(1);
    const [url, options] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://example.com/hook");
    const body = JSON.parse(options.body as string) as WebhookPayload;
    expect(body.notification_type).toBe("registration.completed");
    expect(body.name).toBe("Jane Doe");
  });

  test("does not send webhook when listing has no webhook_url", async () => {
    const dbListing = await createTestListing();
    const listing = makeListing(listingFromDb(dbListing, ""));

    await logAndNotifyRegistration([{ attendee: makeAttendee(), listing }]);
    await flushAsync();

    expect(fetchSpy.calls.length).toBe(0);
  });

  test("records the attendee id on the registration activity log", async () => {
    const dbListing = await createTestListing();
    const listing = makeListing(listingFromDb(dbListing, ""));

    await logAndNotifyRegistration([
      { attendee: makeAttendee({ id: 7 }), listing },
    ]);

    const entry = (await getAllActivityLog()).find((e) =>
      e.message.startsWith("Attendee registered for"),
    );
    expect(entry?.attendee_id).toBe(7);
    expect(entry?.listing_id).toBe(listing.id);
  });
});

describeWithEnv("logAndNotifyRegistration", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

  test("sends webhooks for multi-listing registration", async () => {
    const dbListingA = await createTestListing({
      webhookUrl: "https://hook.com",
    });
    const dbListingB = await createTestListing({
      webhookUrl: "https://hook.com",
    });
    const entries = [
      makeEntry(listingFromDb(dbListingA, "https://hook.com")),
      makeEntry(listingFromDb(dbListingB, "https://hook.com")),
    ];

    await logAndNotifyRegistration(entries);
    await flushAsync();

    expect(fetchSpy.calls.length).toBe(1);
    const [, options] = fetchSpy.calls[0]!.args as [string, RequestInit];
    const body = JSON.parse(options.body as string) as WebhookPayload;
    expect(body.tickets).toHaveLength(2);
  });

  test("does not send webhook when no listings have webhook URLs", async () => {
    const dbListingA = await createTestListing();
    const dbListingB = await createTestListing();
    const entries = [
      makeEntry(listingFromDb(dbListingA, "")),
      makeEntry(listingFromDb(dbListingB, "")),
    ];

    await logAndNotifyRegistration(entries);
    await flushAsync();

    expect(fetchSpy.calls.length).toBe(0);
  });

  test("still sends email when the webhook URL limit is exceeded", async () => {
    await configureTestEmail();
    const entries = Array.from({ length: 17 }, (_, index) =>
      makeEntry({
        id: index + 1,
        webhook_url: `https://hook-${index}.com`,
      }),
    );

    await runWithPendingWork(() => logAndNotifyRegistration(entries));

    expect(fetchSpy.calls.length).toBe(1);
    const [url] = fetchSpy.calls[0]!.args as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed",
      ),
    ).toHaveLength(1);
  });
});
