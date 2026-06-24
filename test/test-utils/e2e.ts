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

// ---------------------------------------------------------------------------
// Common admin actions — composable building blocks for e2e flows.
// ---------------------------------------------------------------------------

/** Open a listing's detail page from the dashboard via its name link and return
 * its numeric id (read from the resulting `/admin/listing/<id>` URL). Starts from
 * `/admin/` so it works regardless of the current page. */
export const gotoListing = async (
  browser: TestBrowser,
  name: string,
): Promise<string> => {
  await browser.visit("/admin/");
  await browser.clickLink(name);
  return browser.currentUrl.split("/").pop()!;
};

/** Create a listing and return its numeric id, landing on its detail page.
 * Defaults to a free, multi-quantity listing; override any field (e.g.
 * `unit_price`). `name` is required and is used to open the new listing. Starts
 * from `/admin/` so back-to-back creates work without manual navigation. */
export const createListing = async (
  browser: TestBrowser,
  fields: Record<string, string> & { name: string },
): Promise<string> => {
  await browser.visit("/admin/");
  await browser.clickLink("Add Listing");
  await browser.submitForm(
    { max_attendees: "50", max_quantity: "5", ...fields },
    "Create Listing",
  );
  return gotoListing(browser, fields.name);
};

/** Add an attendee via the quick-add form on the current listing page. Defaults
 * to quantity 1; pass `quantity` (and any other field) to override. */
export const addAttendee = async (
  browser: TestBrowser,
  fields: Record<string, string> & { name: string },
): Promise<void> => {
  await browser.submitForm({ quantity: "1", ...fields }, "Add Attendee");
};

/** Follow the first attendee-edit link on the current page to its editor. */
export const openAttendeeEditor = async (
  browser: TestBrowser,
): Promise<void> => {
  const link = browser.links.find((l) => l.href.includes("/admin/attendees/"));
  if (!link) throw new Error("no attendee edit link on the current page");
  await browser.visit(link.href);
};

/** The first customer `/t` ticket token linked on the current page. */
export const ticketTokenOnPage = (browser: TestBrowser): string => {
  const match = browser.currentHtml.match(/href="[^"]*\/t\/([^"]+)"/);
  if (!match) throw new Error("no customer /t ticket link on the current page");
  return match[1]!;
};
