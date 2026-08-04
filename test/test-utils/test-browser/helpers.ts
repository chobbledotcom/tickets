/** Stand-ins the TestBrowser's own tests share: a way to hand it a response
 * without a real app behind it, and the two little browsers most form tests
 * want — one that keeps what was posted, one that keeps where it went. */

import type { ResponseHandler } from "#shared/response-steps.ts";
import { extractFormEntries } from "#test-utils/test-browser/forms.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

export const paramsFromEntries = (html: string): URLSearchParams =>
  new URLSearchParams(extractFormEntries(html));

export const useHandler = (
  browser: TestBrowser,
  handler: ResponseHandler<[request: Request]>,
): void => {
  (
    browser as unknown as {
      handleRequest: (request: Request) => Promise<Response>;
    }
  ).handleRequest = (request) => Promise.resolve(handler(request));
};

/** A browser that keeps what its last send carried — where it went and what it
 * said — so a test can read back either, or both. Nothing was sent yet reads
 * as an empty address and an empty body. */
export const recordingBrowser = (): {
  browser: TestBrowser;
  sent: () => { body: string; method: string; path: string; query: string };
} => {
  const browser = new TestBrowser();
  let sent = { body: "", method: "", path: "", query: "" };
  useHandler(browser, async (request) => {
    const url = new URL(request.url);
    sent = {
      body: await request.text(),
      method: request.method,
      path: url.pathname,
      query: url.search,
    };
    return new Response("saved");
  });
  return { browser, sent: () => sent };
};

/** A browser whose sends are read back as what they said. */
export const setupFormSubmit = (): {
  browser: TestBrowser;
  getParams: () => URLSearchParams;
} => {
  const { browser, sent } = recordingBrowser();
  return { browser, getParams: () => new URLSearchParams(sent().body) };
};

/** A browser whose sends are read back by address alone, for the tests about
 * which form a press really belongs to. */
export const postedPathBrowser = (): {
  browser: TestBrowser;
  postedPath: () => string;
} => {
  const { browser, sent } = recordingBrowser();
  return { browser, postedPath: () => sent().path };
};
