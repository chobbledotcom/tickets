import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** Log a fresh browser in as the seeded owner through the real login form. */
export const loginTestAdminBrowser = async (): Promise<TestBrowser> => {
  const browser = new TestBrowser();
  await browser.visit("/admin/");
  await browser.submitForm(
    { password: TEST_ADMIN_PASSWORD, username: TEST_ADMIN_USERNAME },
    "Login",
  );
  return browser;
};
