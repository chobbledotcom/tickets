/**
 * Shared bootstrap for the `*-browser.contract.ts` suites: the app's own
 * loopback server, a real Chromium, and the signed-in page each test runs on.
 * These suites never run in the main test suite; the
 * `test:screenshot-contract` task builds the bundles and provides Chromium.
 */

import { afterAll, beforeAll } from "@std/testing/bdd";
import { type Browser, chromium, type Page } from "playwright";
import {
  browserLaunchOptions,
  withStrictBrowserTimeouts,
} from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { defineLoopbackServer } from "#scripts/specs/evidence/server.ts";
import { denoServeHandler } from "#src/serve-app.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { DescribeEnvOptions } from "#test-utils/internal.ts";
import { testCookie } from "#test-utils/session.ts";

/** The browser contract a describe runs on: the app's loopback address and
 * the browser. The fields answer only inside a test or hook, once the
 * contract is open. */
export type BrowserContract = {
  readonly baseUrl: string;
  readonly browser: Browser;
};

/** describeWithEnv plus the contract browser: the body runs once the
 * contract's server and Chromium are up, and they close after the suite. */
export const describeWithBrowser = (
  name: string,
  options: DescribeEnvOptions,
  fn: (contract: BrowserContract) => void,
): void => {
  const open: { baseUrl: string; browser: Browser | undefined } = {
    baseUrl: "",
    browser: undefined,
  };
  describeWithEnv(name, options, () => {
    // A failed beforeAll leaves nothing to close, and its own error is the
    // failure the suite reports.
    let closeSuite: () => Promise<void> = () => Promise.resolve();
    beforeAll(async () => {
      const server = defineLoopbackServer(denoServeHandler)();
      const browser = await chromium.launch(
        browserLaunchOptions(true, await chromiumExecutable()),
      );
      open.baseUrl = server.baseUrl;
      open.browser = browser;
      closeSuite = async () => {
        await browser.close();
        await server.close();
      };
    });
    afterAll(() => closeSuite());
    fn({
      get baseUrl(): string {
        if (open.browser === undefined) {
          throw new Error("The contract browser is not open");
        }
        return open.baseUrl;
      },
      get browser(): Browser {
        if (open.browser === undefined) {
          throw new Error("The contract browser is not open");
        }
        return open.browser;
      },
    });
  });
};

/** The test owner's session cookie as its name-value pair, the way a
 * browser context's cookie and a fetch's Cookie header both carry it. A
 * malformed cookie string is a broken test fixture, not an empty header. */
export const testOwnerCookiePair = async (): Promise<[string, string]> => {
  const pair = (await testCookie()).split(";", 1)[0];
  const splitAt = pair?.indexOf("=") ?? -1;
  if (pair === undefined || splitAt < 1 || splitAt === pair.length - 1) {
    throw new Error("The test owner cookie is malformed");
  }
  return [pair.slice(0, splitAt), pair.slice(splitAt + 1)];
};

/** A fresh signed-in page on the app's own address, closed with the run. The
 * context carries the test owner's cookie. Reduced motion skips the app's
 * cross-document view transition, whose cross-fade keeps a freshly loaded
 * page's elements unstable for clicks. */
export const withSignedInPage = async <T>(
  browser: Browser,
  baseUrl: string,
  run: (page: Page) => Promise<T>,
): Promise<T> => {
  const context = await browser.newContext({
    baseURL: baseUrl,
    reducedMotion: "reduce",
  });
  withStrictBrowserTimeouts(context);
  const [name, value] = await testOwnerCookiePair();
  await context.addCookies([{ name, url: baseUrl, value }]);
  const page = await context.newPage();
  try {
    return await run(page);
  } finally {
    await context.close();
  }
};
