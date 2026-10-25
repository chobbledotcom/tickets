/**
 * Shared bootstrap for the `*-browser.contract.ts` suites: the app's own
 * loopback server, a real Chromium, and the signed-in page each test runs on.
 * These suites never run in the main test suite; the
 * `test:screenshot-contract` task builds the bundles and provides Chromium.
 */

import { afterAll, beforeAll } from "@std/testing/bdd";
import { type Browser, chromium, type Page } from "playwright";
import { browserLaunchOptions } from "#scripts/browser-options.ts";
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
  const [pair] = (await testCookie()).split(";", 1);
  const splitAt = pair?.indexOf("=") ?? -1;
  if (pair === undefined || splitAt < 1 || splitAt === pair.length - 1) {
    throw new Error("The test owner cookie is malformed");
  }
  await context.addCookies([
    {
      name: pair.slice(0, splitAt),
      url: baseUrl,
      value: pair.slice(splitAt + 1),
    },
  ]);
  const page = await context.newPage();
  try {
    return await run(page);
  } finally {
    await context.close();
  }
};
