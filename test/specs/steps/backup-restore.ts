// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { restoreFromZip } from "#shared/db/backup.ts";
import { adminBrowser } from "#test/specs/support/admin.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { setupTestStorage, teardownTestStorage } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  invalidateAllCaches,
  loggedInAdminBrowser,
  setupAndLogin,
} from "#test-utils/e2e.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

const LISTING = "Summer Concert";
const CUSTOMER = "Jane Doe";
const CUSTOMER_EMAIL = "jane@example.com";

/** The listing and booking every Scenario here starts from. */
const seedListingWithBooking = async (world: TicketsWorld): Promise<void> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    maxQuantity: 5,
    name: LISTING,
  });
  world.listingIds.set(LISTING, listing.id);
  await createTestAttendeeDirect(listing.id, CUSTOMER, CUSTOMER_EMAIL);
};

/** Keep backup files on disk for this Scenario, and clear them afterwards. */
const useLocalBackupStorage = (world: TicketsWorld): void => {
  const dir = setupTestStorage("local");
  world.cleanup.push(() => teardownTestStorage(dir));
};

/** Empty the site and walk the fresh-install setup wizard again. The old
 * session died with the old database, so this is a brand new browser. */
const emptyAndSetUpAgain = async (world: TicketsWorld): Promise<void> => {
  const { initDb, resetDatabase } = await import("#shared/db/migrations.ts");
  await resetDatabase();
  await initDb({ allowMissingSettings: true });
  invalidateAllCaches();
  const browser = new TestBrowser();
  await setupAndLogin(browser);
  world.testBrowser = browser;
};

const dashboard = async (world: TicketsWorld): Promise<string> => {
  const browser = await adminBrowser(world);
  await browser.visit("/admin/");
  return browser.pageText;
};

Given(
  "the organiser has a Summer Concert listing with a booking for Jane Doe",
  function (this: TicketsWorld): Promise<void> {
    return seedListingWithBooking(this);
  },
);

Given(
  "the organiser has taken a backup of a Summer Concert listing with a booking for Jane Doe",
  async function (this: TicketsWorld): Promise<void> {
    useLocalBackupStorage(this);
    await seedListingWithBooking(this);
    const browser = await adminBrowser(this);
    await browser.visit("/admin/backup");
    expect(browser.containsText("Database backup")).toBe(true);
    expect(browser.containsText("Encryption key")).toBe(true);
    await browser.submitForm({}, "Create backup now");
    expect(browser.containsText("Database backup created")).toBe(true);
    const download = browser.links.find((link) =>
      link.text.includes("Download"),
    );
    const zip = await browser.downloadBytes(
      requiredWorldValue(download?.href, "backup download link"),
    );
    expect(zip.length).toBeGreaterThan(0);
    this.backupZip = zip;
  },
);

// The same act is the action of one Scenario and the setup of another, so one
// definition serves both keywords.
Given(
  "the site is emptied and set up again",
  function (this: TicketsWorld): Promise<void> {
    return emptyAndSetUpAgain(this);
  },
);

When(
  "the organiser restores the backup",
  async function (this: TicketsWorld): Promise<void> {
    // A real restore runs out of band, as the console task does: a whole
    // database cannot be written back inside one edge request.
    await restoreFromZip(requiredWorldValue(this.backupZip, "backup file"));
    invalidateAllCaches();
    // Restoring brings back the organiser's own login, so sign in again.
    this.testBrowser = await loggedInAdminBrowser();
  },
);

Then(
  "the dashboard does not show Summer Concert",
  async function (this: TicketsWorld): Promise<void> {
    expect(await dashboard(this)).not.toContain(LISTING);
  },
);

Then(
  "the dashboard shows Summer Concert",
  async function (this: TicketsWorld): Promise<void> {
    expect(await dashboard(this)).toContain(LISTING);
  },
);

Then(
  "the Summer Concert attendee list shows Jane Doe and her email",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await adminBrowser(this);
    await browser.clickLink(LISTING);
    const id = browser.currentUrl.match(/\/admin\/listing\/(\d+)/)?.[1];
    await browser.visit(
      `/admin/listing/${requiredWorldValue(id, "listing id")}/attendees`,
    );
    expect(browser.containsText(CUSTOMER)).toBe(true);
    expect(browser.containsText(CUSTOMER_EMAIL)).toBe(true);
  },
);
