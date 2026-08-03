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

/** A browser whose sends are kept, so a test can read back what was posted. */
export const setupFormSubmit = (): {
  browser: TestBrowser;
  getParams: () => URLSearchParams;
} => {
  const browser = new TestBrowser();
  let posted = "";
  useHandler(browser, async (request) => {
    posted = await request.text();
    return new Response("saved");
  });
  return { browser, getParams: () => new URLSearchParams(posted) };
};

/** A browser whose sends are kept by address alone, for the tests about which
 * form a press really belongs to. */
export const postedPathBrowser = (): {
  browser: TestBrowser;
  postedPath: () => string;
} => {
  const browser = new TestBrowser();
  let path = "";
  useHandler(browser, (request) => {
    path = new URL(request.url).pathname;
    return new Response("saved");
  });
  return { browser, postedPath: () => path };
};
