/**
 * End-to-end test verifying that attendees created via /admin/seeds can be
 * viewed without crashing. Reproduces a bug where the dashboard (which
 * decrypts the newest attendees' PII blobs) throws "Invalid hybrid encrypted
 * data format" because seeded attendees are inserted without a pii_blob.
 *
 * Flow: setup → login → seed 1 event + 1 attendee →
 *       visit /admin (dashboard) → visit event page → visit attendee edit page
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { invalidateEventsCache } from "#shared/db/events.ts";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { DEMO_EVENT_NAMES } from "#shared/demo.ts";

import {
  clearTestEncryptionKey,
  createTestDb,
  resetDb,
  setupTestEncryptionKey,
  TestBrowser,
} from "#test-utils";

/** Invalidate all in-process caches after a destructive DB operation */
const invalidateAllCaches = (): void => {
  settings.invalidateCache();
  settings.setup.clearCache();
  invalidateUsersCache();
  invalidateEventsCache();
  invalidateGroupsCache();
  invalidateHolidaysCache();
  resetSessionCache();
};

describe("e2e: seeded attendee views", () => {
  let browser: TestBrowser;

  beforeEach(async () => {
    setupTestEncryptionKey();
    await createTestDb();
    browser = new TestBrowser();
  });

  afterEach(() => {
    resetDb();
    clearTestEncryptionKey();
  });

  test("setup → seed → dashboard → event page → attendee edit page all render", async () => {
    // 1. Complete initial setup
    await browser.visit("/setup/");
    expect(browser.currentHtml).toContain("Initial Setup");
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
    expect(browser.currentHtml).toContain("Setup Complete");
    invalidateAllCaches();

    // 2. Log in
    await browser.clickLink("Go to Admin Dashboard");
    await browser.submitForm(
      { password: "password", username: "admin" },
      "Login",
    );
    if (browser.containsText("Migration complete")) {
      await browser.clickLink("Back to dashboard");
    }
    expect(browser.containsText("Add Event")).toBe(true);

    // 3. Seed 2 events with 1 attendee each via /admin/seeds.
    //    Even-indexed events get a random unit_price, odd-indexed ones are
    //    free. The free event surfaces an Edit link for the attendee in the
    //    main table; paid-event attendees without a payment_id land in the
    //    Failed Payments table instead (which has no Edit link).
    await browser.visit("/admin/seeds");
    expect(browser.containsText("Seed Data")).toBe(true);
    await browser.submitForm(
      { attendees_per_event: "1", event_count: "2" },
      "Create Seed Data",
    );
    expect(
      browser.containsText("Created 2 event(s) with 2 attendee(s) total"),
    ).toBe(true);

    // 4. Visit the admin dashboard — must not crash decrypting seeded attendees
    await browser.visit("/admin");
    const freeEventName = DEMO_EVENT_NAMES[1]!;
    expect(browser.containsText(freeEventName)).toBe(true);

    // 5. Navigate to the free event's page
    await browser.clickLink(freeEventName);
    expect(browser.currentUrl).toMatch(/^\/admin\/event\/\d+$/);
    expect(browser.containsText(freeEventName)).toBe(true);

    // 6. Navigate to the attendee's edit page via the "Edit" link in the
    //    attendee table. The link href is /admin/attendees/:id.
    const editLink = browser.links.find((l) =>
      /^\/admin\/attendees\/\d+/.test(l.href),
    );
    expect(editLink).toBeTruthy();
    await browser.visit(editLink!.href);
    expect(browser.currentUrl).toMatch(/^\/admin\/attendees\/\d+$/);
    // The edit form exposes the name field for PII editing
    expect(browser.currentHtml).toContain('name="name"');
  });
});
