/**
 * The browser steps both the screenshot runner and the guide recorder need
 * before they can look at an admin page: make the owner, sign in, and give the
 * site a business address. A guide records from the same starting point, so the
 * two tools cannot drift into photographing different sites.
 */

import type { Page } from "playwright";

export const SCREENSHOT_USERNAME = "screenshots";
export const SCREENSHOT_PASSWORD = "screenshots-password";

export const submitServedForm = async (
  page: Page,
  formSelector: string,
): Promise<void> => {
  const form = page.locator(formSelector);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    form.evaluate((element) =>
      Reflect.apply(Reflect.get(element, "submit"), element, []),
    ),
  ]);
};

export const setUpScreenshotAdmin = async (
  page: Page,
  baseUrl: string,
  username = SCREENSHOT_USERNAME,
): Promise<void> => {
  await page.goto(`${baseUrl}/setup/`);
  await page.locator('[name="adminUsername"]').fill(username);
  await page.locator('[name="adminPassword"]').fill(SCREENSHOT_PASSWORD);
  await page.locator('[name="adminPasswordConfirm"]').fill(SCREENSHOT_PASSWORD);
  await page.locator('[name="acceptAgreement"]').check();
  await submitServedForm(page, 'form[action="/setup/"]');

  await page.goto(`${baseUrl}/`);
  await page.locator('[name="username"]').fill(username);
  await page.locator('[name="password"]').fill(SCREENSHOT_PASSWORD);
  await submitServedForm(page, 'form[action="/admin/login"]');

  await page.goto(`${baseUrl}/admin/settings`);
  await page.locator('[name="businessEmail"]').fill("hello@example.com");
  await submitServedForm(page, 'form[action="/admin/settings/business-email"]');
};
