/**
 * Fixtures the webhook suites share: a stubbed fetch that can report what was
 * posted, the default one-line registration, and the console/database chores
 * around a failing send.
 */

import { spy } from "@std/testing/mock";
import { bracket, map } from "#fp";
import { flushPendingWork, runWithPendingWork } from "#shared/pending-work.ts";
import {
  buildWebhookPayload,
  type RegistrationEntry,
  sendWebhook,
  type WebhookListing,
  type WebhookPayload,
} from "#shared/webhook.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { createTestDbWithSetup, resetDb } from "#test-utils/db.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { stubFetchEachTest, type TestFetch } from "#test-utils/fetch-stub.ts";
import type { EmailEntry } from "#test-utils/internal.ts";

/** One registration line: a free listing booked by the default attendee. */
export const defaultEntries = (): EmailEntry[] => [makeEntry()];

/** The first argument of each recorded call, as a string. */
export const spyFirstArgs = map(
  (c: { args: unknown[] }) => c.args[0] as string,
);

/** A console.error spy that restores itself once the work is done. */
export const withErrorSpy = bracket(
  () => spy(console, "error"),
  (s: { restore: () => void }) => s.restore(),
);

/** A stored listing plus a webhook URL, as listing overrides. */
export const listingFromDb = (
  { id, name, slug }: { id: number; name: string; slug: string },
  webhook_url: string,
): Partial<WebhookListing> => ({ id, name, slug, webhook_url });

/** Let the fire-and-forget webhook sends settle. */
export const flushAsync = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Let floating error logs settle, then start the test database over. */
export const drainAndResetDb = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  resetDb();
  await createTestDbWithSetup();
};

/** The stubbed fetch for a webhook suite, plus what the first POST carried. */
export type WebhookFetch = TestFetch & { firstBody: () => WebhookPayload };

/** Stub fetch for every test in the calling describe, answering with an empty
 * response until a test replies differently. */
export const stubWebhookFetch = (): WebhookFetch => {
  const fetch = stubFetchEachTest(() => new Response());
  return {
    get calls(): TestFetch["calls"] {
      return fetch.calls;
    },
    firstBody: () => {
      const [, options] = fetch.calls[0]!.args as [string, RequestInit];
      return JSON.parse(options.body as string) as WebhookPayload;
    },
    reply: fetch.reply,
  };
};

/** Send the default payload with a failing fetch, and return what was logged. */
export const sendAndCollectErrors = (
  fetch: WebhookFetch,
  fetchImpl: () => Promise<Response>,
): Promise<string[]> =>
  withErrorSpy(async (errorSpy) => {
    fetch.reply(fetchImpl);
    const payload = await buildWebhookPayload(defaultEntries(), "GBP");
    await sendWebhook("https://example.com/webhook", payload);
    return spyFirstArgs(errorSpy.calls);
  });

/** Send a webhook that fails with `status`, then return the activity log. */
export const sendWebhookAndGetActivityLog = async (
  fetch: WebhookFetch,
  status: number,
  registrationEntries?: RegistrationEntry[],
): Promise<Awaited<ReturnType<typeof getAllActivityLog>>> => {
  await runWithPendingWork(async () => {
    await withErrorSpy(async () => {
      fetch.reply(() => Promise.resolve(new Response("Error", { status })));
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
