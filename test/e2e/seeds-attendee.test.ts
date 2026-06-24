/**
 * End-to-end test verifying that attendees created via /admin/seeds can be
 * viewed without crashing. Reproduces a bug where the dashboard (which
 * decrypts the newest attendees' PII blobs) throws "Invalid hybrid encrypted
 * data format" because seeded attendees are inserted without a pii_blob.
 *
 * Flow: setup → login → seed 1 listing + 1 attendee →
 *       visit /admin (dashboard) → visit listing page → visit attendee edit page
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { DEMO_LISTING_NAMES } from "#shared/demo.ts";
import { setupAndLogin, useE2eBrowser } from "#test-utils";

// jscpd:ignore-end

describe("e2e: seeded attendee views", () => {
  const ctx = useE2eBrowser();

  test("setup → seed → dashboard → listing page → attendee edit page all render", async () => {
    const browser = ctx.browser;
    await setupAndLogin(browser);
    expect(browser.containsText("Add Listing")).toBe(true);

    // 3. Seed 2 listings with 1 attendee each via /admin/seeds.
    //    Even-indexed listings get a random unit_price, odd-indexed ones are
    //    free. The free listing surfaces an Edit link for the attendee in the
    //    main table; paid-listing attendees without a payment_id land in the
    //    Failed Payments table instead (which has no Edit link).
    await browser.visit("/admin/seeds");
    expect(browser.containsText("Seed Data")).toBe(true);
    await browser.submitForm(
      { attendees_per_listing: "1", listing_count: "2" },
      "Create Seed Data",
    );
    expect(
      browser.containsText("Created 2 listing(s) with 2 attendee(s) total"),
    ).toBe(true);

    // 4. Visit the admin dashboard — must not crash decrypting seeded attendees
    await browser.visit("/admin");
    const freeListingName = DEMO_LISTING_NAMES[1]!;
    expect(browser.containsText(freeListingName)).toBe(true);

    // 5. Navigate to the free listing's page
    await browser.clickLink(freeListingName);
    expect(browser.currentUrl).toMatch(/^\/admin\/listing\/\d+$/);
    expect(browser.containsText(freeListingName)).toBe(true);

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
