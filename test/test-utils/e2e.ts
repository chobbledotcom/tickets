/**
 * Shared end-to-end (TestBrowser) harness: cache invalidation, the fresh-install
 * setup+login flow, and the per-test browser lifecycle — so each e2e spec calls
 * these instead of re-spelling the same boilerplate.
 */

import { afterEach, beforeEach } from "@std/testing/bdd";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import {
  clearTestEncryptionKey,
  setupTestEncryptionKey,
} from "#test-utils/env.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** Invalidate every in-process cache after a fresh-install / destructive DB write. */
export const invalidateAllCaches = (): void => {
  settings.invalidateCache();
  settings.setup.clearCache();
  invalidateUsersCache();
  invalidateListingsCache();
  invalidateGroupsCache();
  invalidateHolidaysCache();
  resetSessionCache();
};

/** Run the setup wizard and log in, landing on the admin dashboard. */
export const setupAndLogin = async (browser: TestBrowser): Promise<void> => {
  await browser.visit("/setup/");
  await browser.submitForm(
    {
      accept_agreement: "yes",
      admin_password: "password",
      admin_password_confirm: "password",
      admin_username: "admin",
      country: "GB",
    },
    "Complete Setup",
  );
  invalidateAllCaches();
  await browser.clickLink("Go to Admin Dashboard");
  await browser.submitForm(
    { password: "password", username: "admin" },
    "Login",
  );
  if (browser.containsText("Migration complete")) {
    await browser.clickLink("Back to dashboard");
  }
};

/** Register the standard e2e browser lifecycle (fresh encryption key + DB +
 * TestBrowser per test) and return a holder whose `.browser` is the current
 * test's browser (assigned in beforeEach, so read it inside the test body). */
export const useE2eBrowser = (): { browser: TestBrowser } => {
  const holder = { browser: null as unknown as TestBrowser };
  beforeEach(async () => {
    setupTestEncryptionKey();
    await createTestDb();
    holder.browser = new TestBrowser();
  });
  afterEach(() => {
    resetDb();
    clearTestEncryptionKey();
  });
  return holder;
};
