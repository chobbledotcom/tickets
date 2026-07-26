/**
 * The one logged-in organiser browser every Feature drives.
 *
 * Scenarios must act through the real rendered admin pages, so each step asks
 * for this browser instead of making its own. The first ask logs in through the
 * production login form and the rest of the Scenario reuses that session.
 */

import type { TicketsWorld } from "#test/specs/support/world.ts";
import { loggedInAdminBrowser } from "#test-utils/e2e.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** Log the organiser in through the real form, once per Scenario. */
export const adminBrowser = async (
  world: TicketsWorld,
): Promise<TestBrowser> => {
  world.testBrowser ??= await loggedInAdminBrowser();
  return world.testBrowser;
};

/** Open an admin page and submit the form its named button belongs to. */
export const submitRenderedForm = async (
  world: TicketsWorld,
  path: string,
  buttonText: string,
  values: Record<string, string | string[]> = {},
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await browser.visit(path);
  await browser.submitForm(values, buttonText);
  return browser;
};
