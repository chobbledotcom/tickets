import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { bracket, map } from "#fp";
import { flushPendingWork, runWithPendingWork } from "#shared/pending-work.ts";
import {
  buildWebhookPayload,
  type RegistrationEntry,
  sendRegistrationWebhooks,
  sendWebhook,
  type WebhookListing,
  type WebhookPayload,
} from "#shared/webhook.ts";
import {
  createTestDbWithSetup,
  createTestListing,
  describeWithEnv,
  type EmailEntry,
  getAllActivityLog,
  makeTestAttendee as makeAttendee,
  makeTestEntry as makeEntry,
  makeTestListing as makeListing,
  resetDb,
} from "#test-utils";

/** Default single-entry registration (free listing, default attendee) */
const defaultEntries = (): EmailEntry[] => [makeEntry()];

/** Extract first arg (as string) from each spy call */
const spyFirstArgs = map((c: { args: unknown[] }) => c.args[0] as string);

/** Bracket-managed console.error spy — auto-restores on completion */
const withErrorSpy = bracket(
  () => spy(console, "error"),
  (s: { restore: () => void }) => s.restore(),
);

/** Convert a db listing + webhook_url into makeListing overrides */
const listingFromDb = (
  { id, name, slug }: { id: number; name: string; slug: string },
  webhook_url: string,
): Partial<WebhookListing> => ({ id, name, slug, webhook_url });

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

  describeWithEnv("buildWebhookPayload", { db: true }, () => {
    beforeEach(async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      s.invalidateCache();
    });

    test("builds payload for a single free listing", async () => {
      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      expect(payload.notification_type).toBe("registration.completed");
      expect(payload.name).toBe("Jane Doe");
      expect(payload.email).toBe("jane@example.com");
      expect(payload.phone).toBe("555-1234");
      expect(payload.price_paid).toBeNull();
      expect(payload.currency).toBe("GBP");
      expect(payload.payment_id).toBeNull();
      expect(payload.ticket_url).toBe("https://localhost/t/AABB001122");
      expect(payload.tickets).toHaveLength(1);
      expect(payload.tickets[0]!.listing_name).toBe("Test Listing");
      expect(payload.tickets[0]!.listing_slug).toBe("test-listing");
      expect(payload.tickets[0]!.unit_price).toBe(0);
      expect(payload.tickets[0]!.quantity).toBe(1);
      expect(payload.tickets[0]!.date).toBeNull();
      expect(payload.tickets[0]!.ticket_token).toBe("AABB001122");
      expect(payload.timestamp).toBeDefined();
      expect(payload.business_email).toBe("");
    });

    test("builds payload for a single paid listing with price_paid on attendee", async () => {
      const entries = [
        makeEntry(
          { unit_price: 500 },
          { payment_id: "pi_abc123", price_paid: "1000", quantity: 2 },
        ),
      ];

      const payload = await buildWebhookPayload(entries, "USD");

      expect(payload.price_paid).toBe(1000);
      expect(payload.payment_id).toBe("pi_abc123");
      expect(payload.currency).toBe("USD");
      expect(payload.tickets[0]!.unit_price).toBe(500);
      expect(payload.tickets[0]!.quantity).toBe(2);
      // Fully paid, so nothing is owed.
      expect(payload.amount_owed).toBe(0);
    });

    test("reports the package override as unit_price, not the amount paid now", async () => {
      // A package member's base listing is free (unit_price 0); its real worth is
      // the package override. Even when the buyer paid less now (a deposit /
      // discount / provider-less order), the webhook reports the full override
      // per unit, not the paid-now amount divided by quantity.
      const entries = [
        makeEntry(
          { id: 42, unit_price: 0 },
          {
            package_group_id: 7,
            payment_id: "pi_pkg",
            price_paid: "3000",
            quantity: 6,
          },
        ),
      ];
      const overrides = new Map([[7, new Map([[42, 900]])]]);

      const payload = buildWebhookPayload(entries, "GBP", overrides);

      // The order reports what was actually paid.
      expect(payload.price_paid).toBe(3000);
      // The per-unit price is the full override (900), not 3000 / 6 = 500.
      expect(payload.tickets[0]!.unit_price).toBe(900);
    });

    test("falls back to the base price for a package member with no override", async () => {
      const entries = [
        makeEntry(
          { id: 43, unit_price: 1200 },
          { package_group_id: 7, price_paid: "1200", quantity: 1 },
        ),
      ];
      // No override row for listing 43 → report the listing's base price.
      const payload = buildWebhookPayload(
        entries,
        "GBP",
        new Map([[7, new Map()]]),
      );
      expect(payload.tickets[0]!.unit_price).toBe(1200);
    });

    test("reports the order's outstanding balance as amount_owed", async () => {
      // A provider-less paid booking: nothing collected (price_paid 0), the full
      // value owed. remaining_balance is order-level, so a multi-listing order
      // reports it once — not summed across the booking lines.
      const entries = [
        makeEntry(
          { id: 1, name: "Listing A", slug: "listing-a", unit_price: 1000 },
          { price_paid: "0", remaining_balance: 3000, ticket_token: "AA00BB" },
        ),
        makeEntry(
          { id: 2, name: "Listing B", slug: "listing-b", unit_price: 2000 },
          { price_paid: "0", remaining_balance: 3000, ticket_token: "CC11DD" },
        ),
      ];

      const payload = await buildWebhookPayload(entries, "GBP");

      expect(payload.price_paid).toBe(0);
      expect(payload.amount_owed).toBe(3000);
    });

    test("builds payload for multi-listing entries", async () => {
      const entries = [
        makeEntry(
          { id: 1, name: "Listing A", slug: "listing-a", unit_price: 300 },
          {
            payment_id: "pi_multi",
            price_paid: "300",
            ticket_token: "AA00BB11CC",
          },
        ),
        makeEntry(
          { id: 2, name: "Listing B", slug: "listing-b", unit_price: 700 },
          {
            payment_id: "pi_multi",
            price_paid: "1400",
            quantity: 2,
            ticket_token: "DD22EE33FF",
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
      expect(payload.tickets[0]!.listing_name).toBe("Listing A");
      expect(payload.tickets[0]!.unit_price).toBe(300);
      expect(payload.tickets[0]!.ticket_token).toBe("AA00BB11CC");
      expect(payload.tickets[1]!.listing_name).toBe("Listing B");
      expect(payload.tickets[1]!.unit_price).toBe(700);
      expect(payload.tickets[1]!.quantity).toBe(2);
      expect(payload.tickets[1]!.ticket_token).toBe("DD22EE33FF");
    });

    test("includes price_paid for free can_pay_more listing where attendee paid", async () => {
      const entries: RegistrationEntry[] = [
        {
          attendee: makeAttendee({
            payment_id: "pi_donate",
            price_paid: "500",
          }),
          listing: makeListing({ can_pay_more: true, unit_price: 0 }),
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

    test("includes mixed dates for multi-listing with daily and standard listings", async () => {
      const entries = [
        makeEntry(
          { id: 1, name: "Daily Listing", slug: "daily-listing" },
          { date: "2025-07-15", ticket_token: "AA00BB11CC" },
        ),
        makeEntry(
          { id: 2, name: "Standard Listing", slug: "standard-listing" },
          { date: null, ticket_token: "DD22EE33FF" },
        ),
      ];

      const payload = await buildWebhookPayload(entries, "GBP");

      expect(payload.tickets[0]!.date).toBe("2025-07-15");
      expect(payload.tickets[1]!.date).toBeNull();
    });

    test("returns 0 price_paid when attendee has no price_paid on paid listing", async () => {
      const payload = await buildWebhookPayload(
        [makeEntry({ unit_price: 500 }, { quantity: 3 })],
        "GBP",
      );

      expect(payload.price_paid).toBe(0);
    });

    test("includes business_email when set", async () => {
      const { updateBusinessEmail } = await import(
        "#shared/validation/email.ts"
      );
      await updateBusinessEmail("contact@example.com");

      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      expect(payload.business_email).toBe("contact@example.com");
    });

    test("includes empty business_email when not set", async () => {
      const payload = await buildWebhookPayload(defaultEntries(), "GBP");

      expect(payload.business_email).toBe("");
    });
  });

  describeWithEnv("sendWebhook", { db: true }, () => {
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
      expect(options.redirect).toBe("manual");
      expect(options.headers).toEqual({ "Content-Type": "application/json" });

      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.notification_type).toBe("registration.completed");
      expect(body.name).toBe("Jane Doe");
      expect(body.tickets).toHaveLength(1);
    });

    test("follows a safe redirect with each hop validated manually", async () => {
      let count = 0;
      restubFetch(() => {
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
      const [firstUrl, firstOptions] = fetchSpy.calls[0].args as [
        string,
        RequestInit,
      ];
      const [secondUrl, secondOptions] = fetchSpy.calls[1].args as [
        string,
        RequestInit,
      ];
      expect(firstUrl).toBe("https://example.com/webhook");
      expect(firstOptions.redirect).toBe("manual");
      expect(secondUrl).toBe("https://hooks.example.org/final");
      expect(secondOptions.redirect).toBe("manual");
    });

    test("refuses to follow an unsafe redirect target", async () => {
      restubFetch(() =>
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
      restubFetch(() => Promise.reject(new Error("Network error")));

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

    /** Send a webhook with a failing fetch, flush, and return activity log entries */
    const sendWebhookAndGetActivityLog = async (
      status: number,
      registrationEntries?: RegistrationEntry[],
    ): Promise<
      ReturnType<typeof getAllActivityLog> extends Promise<infer T> ? T : never
    > => {
      await runWithPendingWork(async () => {
        await withErrorSpy(async () => {
          restubFetch(() => Promise.resolve(new Response("Error", { status })));
          const payload = await buildWebhookPayload(
            registrationEntries ?? defaultEntries(),
            "GBP",
          );
          await sendWebhook("https://example.com/webhook", payload);
        });
        await flushPendingWork();
      });
      return getAllActivityLog();
    };

    const expectWebhookActivityError = async (
      status: number,
      expectedMessage: string,
      registrationEntries?: RegistrationEntry[],
    ) => {
      const logEntries = await sendWebhookAndGetActivityLog(
        status,
        registrationEntries,
      );
      expect(
        logEntries.find((e) => e.message === expectedMessage),
      ).toBeDefined();
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
      const errorEntries = entries.filter((e) =>
        e.message.startsWith("Error:"),
      );
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

  describeWithEnv("sendRegistrationWebhooks", { db: true }, () => {
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
      const [, options] = fetchSpy.calls[0].args as [string, RequestInit];
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.tickets[0]!.unit_price).toBe(900);
    });
  });

  describeWithEnv("logAndNotifyRegistration", { db: true }, () => {
    test("sends webhook when listing has webhook_url", async () => {
      const { logAndNotifyRegistration } = await import("#shared/webhook.ts");
      const dbListing = await createTestListing({
        webhookUrl: "https://example.com/hook",
      });
      const listing = makeListing(
        listingFromDb(dbListing, "https://example.com/hook"),
      );

      await logAndNotifyRegistration([{ attendee: makeAttendee(), listing }]);
      await flushAsync();

      expect(fetchSpy.calls.length).toBe(1);
      const [url, options] = fetchSpy.calls[0].args as [string, RequestInit];
      expect(url).toBe("https://example.com/hook");
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.notification_type).toBe("registration.completed");
      expect(body.name).toBe("Jane Doe");
    });

    test("does not send webhook when listing has no webhook_url", async () => {
      const { logAndNotifyRegistration } = await import("#shared/webhook.ts");
      const dbListing = await createTestListing();
      const listing = makeListing(listingFromDb(dbListing, ""));

      await logAndNotifyRegistration([{ attendee: makeAttendee(), listing }]);
      await flushAsync();

      expect(fetchSpy.calls.length).toBe(0);
    });

    test("records the attendee id on the registration activity log", async () => {
      const { logAndNotifyRegistration } = await import("#shared/webhook.ts");
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
    test("sends webhooks for multi-listing registration", async () => {
      const { logAndNotifyRegistration } = await import("#shared/webhook.ts");
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
      const [, options] = fetchSpy.calls[0].args as [string, RequestInit];
      const body = JSON.parse(options.body as string) as WebhookPayload;
      expect(body.tickets).toHaveLength(2);
    });

    test("does not send webhook when no listings have webhook URLs", async () => {
      const { logAndNotifyRegistration } = await import("#shared/webhook.ts");
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
  });

  describeWithEnv("applyRenewalsForEntries", { db: true }, () => {
    test("skips entries with months_per_unit = 0", async () => {
      const { applyRenewalsForEntries } = await import("#shared/webhook.ts");
      const { bunnyCdnApi } = await import("#shared/bunny-cdn.ts");
      const { hmacHash } = await import("#shared/crypto/hashing.ts");
      const { insertBuiltSite, updateBuiltSiteRenewalState } = await import(
        "#shared/db/built-sites.ts"
      );

      const site = await insertBuiltSite(
        "Renew Skip",
        "skip.test.net",
        "",
        "",
        true,
        "3001",
      );
      const token = "skip-test-token";
      const tokenIndex = await hmacHash(token);
      await updateBuiltSiteRenewalState(site.id, {
        readOnlyFrom: "2099-01-01T00:00:00Z",
        renewalToken: token,
        renewalTokenIndex: tokenIndex,
      });

      const secretStub = stub(bunnyCdnApi, "setEdgeScriptSecret", () =>
        Promise.resolve({ ok: true as const }),
      );

      try {
        const nonRenewalEntry: EmailEntry = makeEntry(
          {
            active: true,
            hidden: false,
            months_per_unit: 0,
            purchase_only: false,
            unit_price: 100,
          },
          { quantity: 1 },
        );
        await applyRenewalsForEntries([nonRenewalEntry], tokenIndex);
        expect(secretStub.calls.length).toBe(0);
      } finally {
        secretStub.restore();
      }
    });
  });
});
