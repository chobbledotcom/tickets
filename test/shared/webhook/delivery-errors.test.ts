import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { runWithPendingWork } from "#shared/pending-work.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import {
  logAndNotifyRegistration,
  sendRegistrationWebhooks,
} from "#shared/webhook.ts";
import {
  flushAsync,
  stubWebhookFetch,
  withErrorSpy,
} from "#test/shared/webhook/helpers.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";

describeWithEnv("registration delivery errors", { db: true }, () => {
  const fetchSpy = stubWebhookFetch();

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

  test("reports unexpected failures from both delivery channels", async () => {
    await configureTestEmail();
    fetchSpy.reply(() =>
      Promise.reject(new Error("unexpected delivery error")),
    );

    const logs = await withErrorSpy(async (errorSpy) => {
      await runWithPendingWork(() =>
        logAndNotifyRegistration([
          makeEntry({ webhook_url: "https://failed-hook.com" }),
        ]),
      );
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("E_WEBHOOK_SEND");
    expect(logs[1]).toContain("E_EMAIL_SEND");
  });

  test("records an email refusal when the webhook throws", async () => {
    await configureTestEmail();
    fetchSpy.reply((url) =>
      url === "https://failed-hook.com"
        ? Promise.reject(new Error("unexpected webhook error"))
        : new Response("refused", { status: 503 }),
    );

    await withErrorSpy(() =>
      runWithPendingWork(() =>
        logAndNotifyRegistration([
          makeEntry({ webhook_url: "https://failed-hook.com" }),
        ]),
      ),
    );

    expect(await activityMessages()).toContain(
      "Registration notification delivery failed",
    );
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

  test("records one activity when webhook and both emails fail", async () => {
    await configureTestEmail({ businessEmail: "admin@example.com" });
    fetchSpy.reply(() => new Response("refused", { status: 503 }));
    const entries = [makeEntry({ webhook_url: "https://failed-hook.com" })];

    const logs = await withErrorSpy(async (errorSpy) => {
      await runWithPendingWork(() => logAndNotifyRegistration(entries));
      return errorSpy.calls;
    });

    expect(fetchSpy.calls).toHaveLength(3);
    expect(logs).toEqual([]);
    expect(
      (await activityMessages()).filter(
        (message) => message === "Registration notification delivery failed",
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
          runWithPendingWork(() => logAndNotifyRegistration(entries)),
        ),
      );
      return errorSpy.calls.map(({ args }) => String(args[0]));
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("E_DB_QUERY");
  });
});
