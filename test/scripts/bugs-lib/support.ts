/** Fixtures and helpers shared by the bugs-lib test files. */

import type { TestFetch } from "#test-utils/fetch-stub.ts";

export const BASE = "https://bugs.example.com";
export const ISSUE_ID = "c9d31a6a-fd2f-4ecf-9369-cc5cb221c606";
export const OTHER_ISSUE_ID = "11111111-2222-4333-8444-555555555555";
export const EVENT_ID = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
export const EVENT_2_ID = "a7a26ff2-e851-45b6-9634-d595f45458b7";
export const CONFIG = { apiKey: "test-key", baseUrl: BASE };
export const ENV = { SENTRY_API_KEY: "test-key", SENTRY_BASE_URL: BASE };

export const ISSUE = {
  bugsink_extra: "kept",
  calculated_type: "Error",
  calculated_value: "boom",
  digest_order: 12,
  digested_event_count: 3,
  first_seen: "2026-09-01T10:00:00Z",
  friendly_id: "TIC-1",
  id: ISSUE_ID,
  is_muted: false,
  is_resolved: false,
  last_seen: "2026-09-02T11:00:00Z",
  project: 1,
  stored_event_count: 3,
  transaction: null,
};

export const EVENT = {
  data: { exception: { values: [{ type: "Error", value: "boom" }] } },
  event_id: "sdk-event-1",
  id: EVENT_ID,
  issue: ISSUE_ID,
  stacktrace_md: "Traceback (most recent call last)...",
  timestamp: "2026-09-02T11:00:00Z",
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });

export const page = (
  results: unknown[],
  next: string | null = null,
): unknown => ({
  next,
  previous: null,
  results,
});

export const eventDetail = (id: string) => ({ ...EVENT, id });

interface FetchCall {
  init: RequestInit;
  url: string;
}

export const callsOf = (fetcher: TestFetch): FetchCall[] =>
  fetcher.calls.map((call) => {
    const [url, init] = call.args as [string, RequestInit];
    return { init, url };
  });

/** Answer every request of one test by URL. */
export const route =
  (fetcher: TestFetch) => (answer: (url: string) => Response) =>
    fetcher.reply((url) => answer(url));

/** Bugsink list routes for a setup with one project holding the given issues. */
/** Bugsink list routes for a setup with one project holding the given issues.
 * The flow asks exactly two URLs, so anything else reads as the projects list. */
export const singleProjectRoutes =
  (issues: unknown[]) =>
  (url: string): Response =>
    url.includes("project=1")
      ? json(page(issues))
      : json(page([{ id: 1, name: "Tickets", slug: "tickets" }]));

export const ioWith = (args: string[], env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    args,
    getEnv: (key: string) => env[key],
    stderr: (line: string) => err.push(line),
    stdout: (line: string) => out.push(line),
  };
  return { err, io, out };
};
