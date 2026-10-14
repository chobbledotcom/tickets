import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { PRICE_TYPE_GROUP } from "#db/price-types.ts";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import { t, withMessageGroups } from "#i18n";
import {
  RegistrationDeliveryError,
  type RegistrationPackageFacts,
} from "#shared/registration-package-facts.ts";
import { initSentry } from "#shared/sentry.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  logAndNotifyRegistration,
  sendRegistrationWebhooks,
} from "#shared/webhook/delivery.ts";
import {
  flushAsync,
  stubWebhookFetch,
  withErrorSpy,
} from "#test/shared/webhook/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendeeWithFlags } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { withEnv } from "#test-utils/env.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { resetSentry } from "#test-utils/sentry.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const registrationLogs = (
  entries: ReturnType<typeof makeEntry>[],
  packageFacts?: RegistrationPackageFacts,
) =>
  withErrorSpy(async (errorSpy) => {
    await withRequestContext(() =>
      logAndNotifyRegistration(entries, { packageFacts, source: "public" }),
    );
    return errorSpy.calls.map(({ args }) => String(args[0]));
  });

const expectOneError = (logs: string[], code: string): string => {
  expect(logs).toHaveLength(1);
  const [log] = logs;
  if (!log) throw new Error("Expected one error log");
  expect(log).toContain(code);
  return log;
};

describeWithEnv("registration delivery errors", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

  test("records failure activity with catalog copy", async () => {
    fetchSpy.reply(() => new Response("refused", { status: 503 }));

    await withRequestContext(() =>
      logAndNotifyRegistration(
        [makeEntry({ webhook_url: "https://failed-hook.com" })],
        { source: "public" },
      ),
    );

    const expected = await withMessageGroups(["activity-log"], () =>
      t("admin.log.registration_delivery_failed"),
    );
    expect(await activityMessages()).toContain(expected);
  });

  test("reports an unexpected failure from pending registration work", async () => {
    fetchSpy.reply(() => Promise.reject(new Error("private failure detail")));
    const entries = [
      makeEntry({ webhook_url: "https://private-webhook.example.com" }),
    ];

    const logs = await registrationLogs(entries);

    expect(expectOneError(logs, "E_REGISTRATION_DELIVERY")).not.toContain(
      "private",
    );
  });

  test("logs a failed pending-flag clear batch locally", async () => {
    // The buyer's confirmation is the run's only delivery and it is accepted,
    // so the clear batch carries the email side alone and is the run's last
    // database call. Starving the budget one call short makes the batch fail:
    // the failure reaches the log, and the accepted send's report is not
    // masked.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Starved Buyer", 1, 1);
    const entries = [
      makeEntry(
        { id: attendee.listing_id, webhook_url: "" },
        {
          email: attendee.email,
          id: attendee.id,
        },
      ),
    ];
    const send = () =>
      withRequestContext(() =>
        logAndNotifyRegistration(entries, {
          clearPendingFlagsFor: [attendee.id],
          source: "public",
        }),
      );
    const calls = await countDatabaseCalls(50, send);
    const logs = await withErrorSpy(async (errorSpy) => {
      await runWithSubrequestBudget(() =>
        withSubrequestAllowance(
          { database: calls - 1, external: 20, total: 40 },
          send,
        ),
      );
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expect(expectOneError(logs, "E_DB_QUERY")).toContain(
      "The pending-flag clear batch failed",
    );
  });

  test("a rejected send with owned flags reports but writes no failure line", async () => {
    // The booking's sends own the attendee's pending flags. The webhook is
    // refused, so the flag must stay up for the admin, the unexpected
    // rejection must still reach the log and alert, and no failure activity
    // line is written — the flags carry the failure instead.
    await configureTestEmail();
    const { attendee } = await bookTestAttendeeWithFlags("Flagged Buyer", 1, 1);
    fetchSpy.reply(() => Promise.reject(new Error("private failure detail")));

    const logs = await withErrorSpy(async (errorSpy) => {
      await withRequestContext(() =>
        logAndNotifyRegistration(
          [
            makeEntry(
              { webhook_url: "https://refused-hook.example.com" },
              { email: attendee.email, id: attendee.id },
            ),
          ],
          { clearPendingFlagsFor: [attendee.id], source: "public" },
        ),
      );
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expectOneError(logs, "E_REGISTRATION_DELIVERY");
    const row = await queryOne<{
      email_pending: number;
      webhooks_pending: number;
    }>("SELECT email_pending, webhooks_pending FROM attendees WHERE id = ?", [
      attendee.id,
    ]);
    expect(row).toEqual({ email_pending: 1, webhooks_pending: 1 });
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(0);
  });

  test("an owner-only copy never clears the buyer's email flag", async () => {
    // The attendee carries no address, so the send delivers the owner's
    // admin copy alone. The owner's copy is accepted, but it is not the
    // buyer's confirmation: the flag that says the buyer's confirmation is
    // owed stays up, so adding the missing address later restores the
    // warning. The webhook send was attempted and accepted, so its flag
    // clears.
    await configureTestEmail({ businessEmail: "owner@example.com" });
    const { attendee } = await bookTestAttendeeWithFlags(
      "No Address Buyer",
      1,
      1,
    );
    fetchSpy.reply(() => new Response("{}"));

    await withRequestContext(() =>
      logAndNotifyRegistration(
        [
          makeEntry(
            { webhook_url: "https://owner-only-hook.example.com" },
            { email: "", id: attendee.id },
          ),
        ],
        { clearPendingFlagsFor: [attendee.id], source: "public" },
      ),
    );

    const row = await queryOne<{
      email_pending: number;
      webhooks_pending: number;
    }>("SELECT email_pending, webhooks_pending FROM attendees WHERE id = ?", [
      attendee.id,
    ]);
    expect(row).toEqual({ email_pending: 1, webhooks_pending: 0 });
  });

  test("reports one incident for unexpected failures in both delivery channels", async () => {
    await configureTestEmail();
    fetchSpy.reply(() =>
      Promise.reject(new Error("unexpected delivery error")),
    );

    const logs = await registrationLogs([
      makeEntry({ webhook_url: "https://failed-hook.com" }),
    ]);

    expectOneError(logs, "E_REGISTRATION_DELIVERY");
  });

  test("reports template fallbacks as one registration incident", async () => {
    await configureTestEmail();
    await settings.update.email.template(
      "confirmation",
      "subject",
      "{{ subject | missing_subject_filter }}",
    );
    await settings.update.email.template(
      "confirmation",
      "html",
      "{{ html | missing_html_filter }}",
    );
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    fetchSpy.reply(() => new Response("{}"));

    const logs = await registrationLogs([makeEntry()]);

    expectOneError(logs, "E_REGISTRATION_DELIVERY");
    expect(fetchSpy.calls).toHaveLength(1);
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(1);
  });

  test("rejects an unknown stored email provider before sending", async () => {
    await configureTestEmail();
    await execute("UPDATE settings SET value = ? WHERE key = ?", [
      "unknown-provider",
      "email_provider",
    ]);
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    const logs = await registrationLogs([makeEntry()]);

    expectOneError(logs, "E_REGISTRATION_DELIVERY");
    expect(fetchSpy.calls).toEqual([]);
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(1);
  });

  test("reports an error while a notification channel is prepared", async () => {
    await configureTestEmail();
    const privateValue = "PRIVATE-CHANNEL-PREPARATION-ERROR";
    const displays = new Map();
    displays.get = () => {
      throw new Error(privateValue);
    };

    const logs = await registrationLogs(
      [makeEntry({}, { package_group_id: 1 })],
      { displays, pricingByGroup: new Map() },
    );

    expect(expectOneError(logs, "E_REGISTRATION_DELIVERY")).not.toContain(
      privateValue,
    );
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(1);
  });

  test("records an email refusal when the webhook throws", async () => {
    await configureTestEmail();
    fetchSpy.reply((url) =>
      url === "https://failed-hook.com"
        ? Promise.reject(new Error("unexpected webhook error"))
        : new Response("refused", { status: 503 }),
    );

    await withErrorSpy(() =>
      withRequestContext(() =>
        logAndNotifyRegistration(
          [makeEntry({ webhook_url: "https://failed-hook.com" })],
          { source: "public" },
        ),
      ),
    );

    expect(await activityMessages()).toContain(
      "Registration notification delivery failed.",
    );
  });

  test("records a refused sibling when another webhook throws", async () => {
    fetchSpy.reply((url) =>
      url === "https://refused-hook.com"
        ? new Response("refused", { status: 503 })
        : Promise.reject(new Error("unexpected webhook error")),
    );

    await withErrorSpy(() =>
      withRequestContext(() =>
        logAndNotifyRegistration(
          [
            makeEntry({ id: 1, webhook_url: "https://refused-hook.com" }),
            makeEntry({ id: 2, webhook_url: "https://failed-hook.com" }),
          ],
          { source: "public" },
        ),
      ),
    );

    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(1);
  });

  test("keeps raw delivery errors out of the incident fan-out", async () => {
    const privateValue = "PRIVATE-DELIVERY-ERROR";
    using _env = withEnv({
      NTFY_URL: "https://ntfy.example.test/delivery",
      SENTRY_URL: "https://key@bugs.example.test/2",
    });
    await configureTestEmail();
    await initSentry();
    fetchSpy.reply((url) =>
      url.includes("ntfy.example.test") || url.includes("bugs.example.test")
        ? new Response("{}")
        : Promise.reject(new Error(privateValue)),
    );

    try {
      const logs = await registrationLogs([
        makeEntry({ webhook_url: "https://failed-hook.com" }),
      ]);
      const sentryCall = fetchSpy.calls.find(({ args }) =>
        String(args[0]).includes("bugs.example.test"),
      );
      if (!sentryCall) throw new Error("Sentry request was not sent");
      const body = (sentryCall.args[1] as RequestInit).body;
      const sentryBody =
        typeof body === "string"
          ? body
          : new TextDecoder().decode(body as Uint8Array);

      expect(expectOneError(logs, "E_REGISTRATION_DELIVERY")).not.toContain(
        privateValue,
      );
      expect(sentryBody).toContain("Registration notification delivery failed");
      expect(sentryBody).not.toContain(privateValue);
      expect(
        fetchSpy.calls.filter(({ args }) =>
          String(args[0]).includes("ntfy.example.test"),
        ),
      ).toHaveLength(1);
      expect(
        fetchSpy.calls.filter(({ args }) =>
          String(args[0]).includes("bugs.example.test"),
        ),
      ).toHaveLength(1);
    } finally {
      resetSentry();
    }
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
          await sendRegistrationWebhooks(entries, "GBP", "public");
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
      const error = await outcome.promise;
      expect(error).toBeInstanceOf(RegistrationDeliveryError);
      if (!(error instanceof RegistrationDeliveryError)) throw error;
      expect(error.reasons).toEqual([unexpected]);
    });
  });

  test("records one activity when webhook and both emails fail", async () => {
    await configureTestEmail({ businessEmail: "admin@example.com" });
    fetchSpy.reply(() => new Response("refused", { status: 503 }));
    const entries = [makeEntry({ webhook_url: "https://failed-hook.com" })];

    const logs = await withErrorSpy(async (errorSpy) => {
      await withRequestContext(() =>
        logAndNotifyRegistration(entries, { source: "public" }),
      );
      return errorSpy.calls;
    });

    expect(fetchSpy.calls).toHaveLength(3);
    expect(logs).toEqual([]);
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed.",
      ),
    ).toHaveLength(1);
  });

  test("reports a failure-activity write error locally", async () => {
    const entries = [
      makeEntry({ webhook_url: "http://unsafe-webhook.example.com" }),
    ];

    const logs = await withErrorSpy(async (errorSpy) => {
      await runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 1, external: 0, total: 1 }, () =>
          withRequestContext(() =>
            logAndNotifyRegistration(entries, { source: "public" }),
          ),
        ),
      );
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    // The detail names the write that failed, so an operator can tell a
    // broken delivery write from every other database error.
    expect(expectOneError(logs, "E_DB_QUERY")).toContain(
      "Registration delivery failure activity write",
    );
  });

  test("prices the notification from the loaded package facts", async () => {
    // Webhooks on: the queue loads the package pricing and hands it to the
    // send, so the payload's ticket price is the package's flat override
    // (2500), not the member listing's own price.
    const group = await createTestGroup({ isPackage: true });
    const listing = await createTestListing();
    await assignListingsToGroup([listing.id], group.id);
    await execute(
      "INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price) VALUES (?, ?, ?, ?)",
      [listing.id, PRICE_TYPE_GROUP, String(group.id), 2500],
    );
    const entry = makeEntry(
      { id: listing.id, webhook_url: "https://hook.example.com" },
      { package_group_id: group.id },
    );

    await withErrorSpy(() =>
      withRequestContext(() =>
        logAndNotifyRegistration([entry], { source: "public" }),
      ),
    );

    expect(fetchSpy.firstBody().tickets[0]!.unit_price).toBe(2500);
  });
});
