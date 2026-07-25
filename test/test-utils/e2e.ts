/**
 * Shared end-to-end (TestBrowser) harness: cache invalidation, the fresh-install
 * setup+login flow, and the per-test browser lifecycle — so each e2e spec calls
 * these instead of re-spelling the same boilerplate.
 */

import { afterEach, beforeEach } from "@std/testing/bdd";
import { invalidateCachesForTable } from "#shared/cache-registry.ts";
import { groups } from "#shared/db/groups.ts";
import { holidays } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { attendeeLineIndex } from "#test-utils/assertions.ts";
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
  groups.cache.invalidate();
  holidays.invalidate();
  invalidateCachesForTable("sessions");
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
  await browser.clickLink("Log In");
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
  // The listing name links to the Overview tab; these flows work with the
  // roster (attendees, check-in, edit links), so land on the Attendees tab.
  const id = browser.currentUrl.split("/").pop()!;
  await browser.visit(`/admin/listing/${id}/attendees`);
  return id;
};

/** Create a listing and return its numeric id, landing on its detail page.
 * Defaults to a free, multi-quantity listing; override any field (e.g.
 * `unit_price`). `name` is required and is used to open the new listing. Starts
 * from `/admin/` so back-to-back creates work without manual navigation. */
export const createListing = async (
  browser: TestBrowser,
  fields: Record<string, string> & { name: string },
): Promise<string> => {
  await browser.visit("/admin/listing/new?template=custom");
  await browser.submitForm(
    { max_attendees: "50", max_quantity: "5", ...fields },
    "Create Listing",
  );
  return gotoListing(browser, fields.name);
};

/** Add an attendee via the quick-add form, which lives on the listing's
 * Attendees tab. Navigates there from the current listing URL first. Defaults
 * to quantity 1; pass `quantity` (and any other field) to override. */
export const addAttendee = async (
  browser: TestBrowser,
  fields: Record<string, string> & { name: string },
): Promise<void> => {
  const id = browser.currentUrl.match(/\/admin\/listing\/(\d+)/)?.[1];
  if (id) await browser.visit(`/admin/listing/${id}/attendees`);
  await browser.submitForm({ quantity: "1", ...fields }, "Add Attendee");
};

/** Follow the first attendee-edit link on the current page to its editor. */
export const openAttendeeEditor = async (
  browser: TestBrowser,
): Promise<void> => {
  // A numeric id specifically — the admin nav's own "Add Attendee" link
  // (/admin/attendees/new) also matches a bare "/admin/attendees/" substring.
  const link = browser.links.find((l) =>
    /\/admin\/attendees\/\d+/.test(l.href),
  );
  if (!link) throw new Error("no attendee edit link on the current page");
  await browser.visit(link.href);
  // The form lives on the Edit tab of the attendee entity page; the strip
  // always links it, so follow it like an operator would.
  const editTab = browser.links.find((l) =>
    /\/admin\/attendees\/\d+\/edit$/.test(l.href),
  )!;
  await browser.visit(editTab.href);
};

/** The attendee editor's line index for a listing on the CURRENT page — the
 * row-per-path editor names its per-line fields (`qty_<i>`, `noqty_<i>`) by
 * line position, not listing id, so drivers resolve the index from the
 * rendered form before each submit (a save re-orders the lines). */
export const lineIndexOnPage = (
  browser: TestBrowser,
  listingId: string | number,
): string => {
  const index = attendeeLineIndex(browser.currentHtml, Number(listingId));
  if (index === null) {
    throw new Error(`no editor line for listing ${listingId} on this page`);
  }
  return index;
};
