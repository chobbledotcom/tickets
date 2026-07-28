import { logInAsTestAdmin } from "#test-utils/e2e.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import type { TicketsWorld } from "./world.ts";

export const scenarioBrowser = (world: TicketsWorld): TestBrowser => {
  world.testBrowser ??= new TestBrowser();
  return world.testBrowser;
};

/** Forget the Scenario's browser, so the next ask starts a fresh one. Use this
 * after the site itself is replaced and the old session can no longer work. */
export const resetScenarioBrowser = (world: TicketsWorld): void => {
  delete world.testBrowser;
};

export const adminBrowser = async (
  world: TicketsWorld,
): Promise<TestBrowser> => {
  const browser = scenarioBrowser(world);
  await browser.visit("/admin/");
  if (browser.containsText("Login")) await logInAsTestAdmin(browser);
  return browser;
};

/** The organiser opens one of their own pages, signing in first if they are not
 * already. Every admin page a story reads starts here. */
export const openAdminPage = async (
  world: TicketsWorld,
  path: string,
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await browser.visit(path);
  return browser;
};

export const submitRenderedAdminForm = async (
  world: TicketsWorld,
  path: string,
  buttonText: string,
  values: Record<string, string> = {},
): Promise<TestBrowser> => {
  const browser = await openAdminPage(world, path);
  await browser.submitForm(values, buttonText);
  return browser;
};
