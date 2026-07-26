import { logInAsTestAdmin } from "#test-utils/e2e.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import type { TicketsWorld } from "./world.ts";

export const scenarioBrowser = (world: TicketsWorld): TestBrowser => {
  world.testBrowser ??= new TestBrowser();
  return world.testBrowser;
};

export const adminBrowser = async (
  world: TicketsWorld,
): Promise<TestBrowser> => {
  const browser = scenarioBrowser(world);
  await browser.visit("/admin/");
  if (browser.containsText("Login")) await logInAsTestAdmin(browser);
  return browser;
};

export const submitRenderedAdminForm = async (
  world: TicketsWorld,
  path: string,
  buttonText: string,
  values: Record<string, string> = {},
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await browser.visit(path);
  await browser.submitForm(values, buttonText);
  return browser;
};
