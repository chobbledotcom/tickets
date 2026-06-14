/**
 * End-to-end ticket editing flow test.
 *
 * Simulates an admin managing attendees across multiple listings using TestBrowser,
 * which navigates purely by following links (by text) and submitting forms
 * (by button text) — just like a human would.
 *
 * Flow: setup → login → create two listings → add two attendees to listing 1 →
 *       move each attendee to listing 2 via admin tools (add link + remove link) →
 *       verify listing 1 is empty and listing 2 has both attendees
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";

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
  invalidateListingsCache();
  invalidateGroupsCache();
  invalidateHolidaysCache();
  resetSessionCache();
};

/**
 * Extract the listing ID for a named listing from a select option in the current page HTML.
 * Used to find the listing_id value needed to submit the "Add to Listing" form.
 */
const extractListingIdFromSelect = (
  html: string,
  listingName: string,
): string | null => {
  const escaped = listingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<option[^>]*\\bvalue="(\\d+)"[^>]*>\\s*${escaped}\\s*<\\/option>`,
    ),
  );
  return match?.[1] ?? null;
};

/**
 * Navigate to the attendee edit page from the current listing detail page.
 * The listing page has both an "Edit listing" link and "Edit attendee" links.
 * This finds the first /admin/attendees/ link to reach the attendee edit page.
 */
const visitFirstAttendeeEditPage = async (
  browser: TestBrowser,
): Promise<void> => {
  const link = browser.links.find((l) => l.href.includes("/admin/attendees/"));
  if (!link) throw new Error("No attendee edit link found on page");
  await browser.visit(link.href);
};

describe("e2e: ticket editing flow", () => {
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

  test("edit attendee contact info preserves bookings", async () => {
    // 1. Setup: create admin, log in, create listing with two attendees
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

    // Create listing
    await browser.clickLink("Add Listing");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Art Class" },
      "Create Listing",
    );

    // Add Alice with quantity 2
    await browser.clickLink("Art Class");
    await browser.submitForm(
      { name: "Alice Smith", quantity: "2" },
      "Add Attendee",
    );
    expect(browser.containsText("Added Alice Smith")).toBe(true);

    // Add Bob with quantity 1
    await browser.submitForm(
      { name: "Bob Jones", quantity: "1" },
      "Add Attendee",
    );
    expect(browser.containsText("Added Bob Jones")).toBe(true);

    // 2. Check Alice in — the "Check in" button on the listing page
    //    Alice appears first alphabetically, so her Check in button comes first.
    await browser.submitForm({}, "Check in");
    expect(browser.containsText("Checked Alice Smith in")).toBe(true);

    // 3. Navigate to Alice's edit page and update her contact info
    await visitFirstAttendeeEditPage(browser);
    expect(browser.containsText("Alice Smith")).toBe(true);

    // Verify her current booking details on the edit page:
    // The Listing Registrations table shows quantity and checked-in badge
    expect(browser.currentHtml).toContain("Checked in");

    await browser.submitForm(
      {
        address: "42 Oak Street",
        email: "alice.johnson@example.com",
        name: "Alice Johnson",
        phone: "+449876543210",
        special_instructions: "Needs wheelchair access",
      },
      "Save Contact Info",
    );
    // Redirects to listing page with flash message
    expect(browser.containsText("Updated Alice Johnson")).toBe(true);

    // 4. Verify edited details appear on the listing page
    expect(browser.containsText("Alice Johnson")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(false);

    // 5. Navigate back to Alice's edit page to verify all fields were saved
    //    and booking properties are intact
    await visitFirstAttendeeEditPage(browser);
    expect(browser.containsText("Alice Johnson")).toBe(true);
    // Verify saved contact fields appear in the form
    expect(browser.currentHtml).toContain("alice.johnson@example.com");
    expect(browser.currentHtml).toContain("+449876543210");
    expect(browser.currentHtml).toContain("42 Oak Street");
    expect(browser.currentHtml).toContain("Needs wheelchair access");
    // Verify booking preserved: quantity still 2 and still checked in
    expect(browser.currentHtml).toContain('value="2"');
    expect(browser.currentHtml).toContain("Checked in");

    // 6. Go back to the listing page and navigate to Bob's edit page.
    //    Alice (now Alice Johnson) appears first alphabetically, Bob second.
    await browser.visit("/admin/");
    await browser.clickLink("Art Class");

    // Bob should not be checked in — his button says "Check in"
    // and Alice should show "Check out" (since she is checked in)
    expect(browser.containsText("Bob Jones")).toBe(true);
    expect(browser.containsText("Check out")).toBe(true);

    // Find Bob's edit link — he's the second attendee. Each row now links to
    // the attendee edit page from both the name and the Edit action, so dedupe
    // by attendee id before indexing.
    const attendeeIds = browser.links
      .map((l) => l.href.match(/\/admin\/attendees\/(\d+)/)?.[1])
      .filter((id): id is string => !!id);
    const uniqueAttendeeIds = [...new Set(attendeeIds)];
    expect(uniqueAttendeeIds.length).toBeGreaterThanOrEqual(2);
    await browser.visit(`/admin/attendees/${uniqueAttendeeIds[1]}`);
    expect(browser.containsText("Bob Jones")).toBe(true);

    // Verify Bob is NOT checked in on his edit page
    expect(browser.currentHtml).not.toContain("Checked in");

    // 7. Edit Bob's contact info
    await browser.submitForm(
      {
        address: "7 Pine Avenue",
        email: "robert@example.com",
        name: "Robert Jones",
        phone: "+441111222333",
        special_instructions: "Vegetarian meals",
      },
      "Save Contact Info",
    );
    expect(browser.containsText("Updated Robert Jones")).toBe(true);

    // 8. Verify Bob's edit was saved and his booking is intact
    expect(browser.containsText("Robert Jones")).toBe(true);
    expect(browser.containsText("Bob Jones")).toBe(false);

    // Navigate to Bob's edit page to verify fields and booking. Dedupe by
    // attendee id since each row links from both the name and the Edit action.
    const bobAttendeeIds = [
      ...new Set(
        browser.links
          .map((l) => l.href.match(/\/admin\/attendees\/(\d+)/)?.[1])
          .filter((id): id is string => !!id),
      ),
    ];
    // Bob (Robert Jones) should be the second attendee
    await browser.visit(`/admin/attendees/${bobAttendeeIds[1]}`);
    expect(browser.currentHtml).toContain("robert@example.com");
    expect(browser.currentHtml).toContain("+441111222333");
    expect(browser.currentHtml).toContain("7 Pine Avenue");
    expect(browser.currentHtml).toContain("Vegetarian meals");
    // Booking preserved: quantity still 1, not checked in
    expect(browser.currentHtml).toContain('value="1"');
    expect(browser.currentHtml).not.toContain("Checked in");

    // 9. Final verification: go back to listing page and confirm both
    //    attendees have their updated names and original booking properties
    await browser.visit("/admin/");
    await browser.clickLink("Art Class");
    expect(browser.containsText("Alice Johnson")).toBe(true);
    expect(browser.containsText("Robert Jones")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(false);
    expect(browser.containsText("Bob Jones")).toBe(false);
  });

  test("create listings → add attendees → move attendees between listings", async () => {
    // 1. Visit setup directly — initial DB creation is only allowed there.
    await browser.visit("/setup/");
    expect(browser.currentHtml).toContain("Initial Setup");

    // 2. Complete setup
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

    // Invalidate settings cache so subsequent requests see the newly written keys.
    invalidateAllCaches();

    // 3. Log in
    await browser.clickLink("Go to Admin Dashboard");
    await browser.submitForm(
      { password: "password", username: "admin" },
      "Login",
    );
    if (browser.containsText("Migration complete")) {
      await browser.clickLink("Back to dashboard");
    }
    expect(browser.containsText("Add Listing")).toBe(true);

    // 4. Create Listing 1: "Morning Workshop"
    await browser.clickLink("Add Listing");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Morning Workshop" },
      "Create Listing",
    );
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 5. Create Listing 2: "Evening Seminar"
    await browser.clickLink("Add Listing");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Evening Seminar" },
      "Create Listing",
    );
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 6. Navigate to Morning Workshop and add Alice as the first attendee
    await browser.clickLink("Morning Workshop");
    expect(browser.containsText("Add Attendee")).toBe(true);

    await browser.submitForm(
      { name: "Alice Smith", quantity: "1" },
      "Add Attendee",
    );
    // Flash confirms attendee was added; Alice appears in the attendee list
    expect(browser.containsText("Added Alice Smith")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(true);

    // 7. Navigate to Alice's edit page.
    //    She is the only attendee in Morning Workshop, so the first attendee edit link is hers.
    //    (The listing page also has its own "Edit" link which comes first in the DOM — we
    //    find the /admin/attendees/ link instead to avoid ambiguity.)
    await visitFirstAttendeeEditPage(browser);
    expect(browser.containsText("Alice Smith")).toBe(true);

    // The Listing Registrations table shows Morning Workshop as a registered listing link.
    // (Note: the "Add to Listing" select also lists listing names, so we check for the
    //  admin/listing link in the registration table to confirm the actual registration.)
    expect(browser.currentHtml).toContain("/admin/listing/");
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 8. Extract the Evening Seminar listing ID from the "Add to Listing" select options
    const eveningSeminarId = extractListingIdFromSelect(
      browser.currentHtml,
      "Evening Seminar",
    );
    expect(eveningSeminarId).toBeTruthy();

    // 9. Add Alice to Evening Seminar via the "Add to Listing" form
    await browser.submitForm(
      { listing_id: eveningSeminarId!, quantity: "1" },
      "Add to Listing",
    );
    // Flash confirms Alice was added to Evening Seminar
    expect(browser.containsText("Added to Evening Seminar")).toBe(true);
    // Both listings now appear in the Listing Registrations table as links
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 10. Remove Alice from Morning Workshop.
    //     Listing links are ordered by listing_id ascending, so Morning Workshop
    //     (lower ID) appears first in the Listing Registrations table.
    //     The first "Remove" form targets Morning Workshop.
    await browser.submitForm({}, "Remove");
    expect(
      browser.containsText("Attendee unlinked from 'Morning Workshop'"),
    ).toBe(true);

    // 11. Navigate back to Morning Workshop and confirm Alice is no longer there.
    //     Then add Bob as the second attendee.
    await browser.visit("/admin/");
    await browser.clickLink("Morning Workshop");
    expect(browser.containsText("Alice Smith")).toBe(false);

    await browser.submitForm(
      { name: "Bob Jones", quantity: "1" },
      "Add Attendee",
    );
    expect(browser.containsText("Added Bob Jones")).toBe(true);
    expect(browser.containsText("Bob Jones")).toBe(true);
    // Alice was already moved to Evening Seminar — she must not appear here
    expect(browser.containsText("Alice Smith")).toBe(false);

    // 12. Navigate to Bob's edit page.
    //     He is the only attendee in Morning Workshop, so the first attendee edit link is his.
    await visitFirstAttendeeEditPage(browser);
    expect(browser.containsText("Bob Jones")).toBe(true);
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 13. Add Bob to Evening Seminar using the same listing ID extracted earlier
    await browser.submitForm(
      { listing_id: eveningSeminarId!, quantity: "1" },
      "Add to Listing",
    );
    expect(browser.containsText("Added to Evening Seminar")).toBe(true);
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 14. Remove Bob from Morning Workshop (first "Remove" form = Morning Workshop)
    await browser.submitForm({}, "Remove");
    expect(
      browser.containsText("Attendee unlinked from 'Morning Workshop'"),
    ).toBe(true);

    // 15. Verify Morning Workshop is now empty — neither Alice nor Bob appear
    await browser.visit("/admin/");
    await browser.clickLink("Morning Workshop");
    expect(browser.containsText("Alice Smith")).toBe(false);
    expect(browser.containsText("Bob Jones")).toBe(false);

    // 16. Verify Evening Seminar has both attendees
    await browser.visit("/admin/");
    await browser.clickLink("Evening Seminar");
    expect(browser.containsText("Alice Smith")).toBe(true);
    expect(browser.containsText("Bob Jones")).toBe(true);
  });
});
