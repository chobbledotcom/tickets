/**
 * Fixtures the webhook suites share: a stubbed fetch that can report what was
 * posted, the default one-line registration, and the console/database chores
 * around a failing send.
 */

import { spy } from "@std/testing/mock";
import { bracket, map } from "#fp";
import type { WebhookListing, WebhookPayload } from "#shared/webhook.ts";
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
