/**
 * End-to-end ticket editing flow test.
 *
 * Simulates an admin managing attendees across multiple events using TestBrowser,
 * which navigates purely by following links (by text) and submitting forms
 * (by button text) — just like a human would.
 *
 * Flow: setup → login → create two events → add two attendees to event 1 →
 *       move each attendee to event 2 via admin tools (add link + remove link) →
 *       verify event 1 is empty and event 2 has both attendees
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { invalidateEventsCache } from "#lib/db/events.ts";
import { invalidateGroupsCache } from "#lib/db/groups.ts";
import { invalidateHolidaysCache } from "#lib/db/holidays.ts";
import { resetSessionCache } from "#lib/db/sessions.ts";
import { settings } from "#lib/db/settings.ts";
import { invalidateUsersCache } from "#lib/db/users.ts";

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

/**
 * Extract the event ID for a named event from a select option in the current page HTML.
 * Used to find the event_id value needed to submit the "Add to Event" form.
 */
const extractEventIdFromSelect = (
  html: string,
  eventName: string,
): string | null => {
  const match = html.match(
    new RegExp(
      `<option value="(\\d+)"[^>]*>\\s*${eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*<\\/option>`,
    ),
  );
  return match?.[1] ?? null;
};

/**
 * Navigate to the attendee edit page from the current event detail page.
 * The event page has both an "Edit event" link and "Edit attendee" links.
 * This finds the first /admin/attendees/ link to reach the attendee edit page.
 */
const visitFirstAttendeeEditPage = async (browser: TestBrowser): Promise<void> => {
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

  test("create events → add attendees → move attendees between events", async () => {
    // 1. Visit homepage — should redirect to setup since no setup done
    await browser.visit("/");
    expect(browser.currentHtml).toContain("Initial Setup");

    // 2. Complete setup
    await browser.submitForm(
      {
        admin_username: "admin",
        admin_password: "password",
        admin_password_confirm: "password",
        country: "GB",
        accept_agreement: "yes",
      },
      "Complete Setup",
    );
    expect(browser.currentHtml).toContain("Setup Complete");

    // Invalidate settings cache so subsequent requests see the newly written keys.
    invalidateAllCaches();

    // 3. Log in
    await browser.clickLink("Go to Admin Dashboard");
    await browser.submitForm(
      { username: "admin", password: "password" },
      "Login",
    );
    if (browser.containsText("Migration complete")) {
      await browser.clickLink("Back to dashboard");
    }
    expect(browser.containsText("Add Event")).toBe(true);

    // 4. Create Event 1: "Morning Workshop"
    await browser.clickLink("Add Event");
    await browser.submitForm(
      { name: "Morning Workshop", max_attendees: "50", max_quantity: "5" },
      "Create Event",
    );
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 5. Create Event 2: "Evening Seminar"
    await browser.clickLink("Add Event");
    await browser.submitForm(
      { name: "Evening Seminar", max_attendees: "50", max_quantity: "5" },
      "Create Event",
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
    //    (The event page also has its own "Edit" link which comes first in the DOM — we
    //    find the /admin/attendees/ link instead to avoid ambiguity.)
    await visitFirstAttendeeEditPage(browser);
    expect(browser.containsText("Alice Smith")).toBe(true);

    // The Event Registrations table shows Morning Workshop as a registered event link.
    // (Note: the "Add to Event" select also lists event names, so we check for the
    //  admin/event link in the registration table to confirm the actual registration.)
    expect(browser.currentHtml).toContain("/admin/event/");
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 8. Extract the Evening Seminar event ID from the "Add to Event" select options
    const eveningSeminarId = extractEventIdFromSelect(
      browser.currentHtml,
      "Evening Seminar",
    );
    expect(eveningSeminarId).toBeTruthy();

    // 9. Add Alice to Evening Seminar via the "Add to Event" form
    await browser.submitForm(
      { event_id: eveningSeminarId!, quantity: "1" },
      "Add to Event",
    );
    // Flash confirms Alice was added to Evening Seminar
    expect(browser.containsText("Added to Evening Seminar")).toBe(true);
    // Both events now appear in the Event Registrations table as links
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 10. Remove Alice from Morning Workshop.
    //     Event links are ordered by event_id ascending, so Morning Workshop
    //     (lower ID) appears first in the Event Registrations table.
    //     The first "Remove" form targets Morning Workshop.
    await browser.submitForm({}, "Remove");
    expect(browser.containsText("Removed from Morning Workshop")).toBe(true);

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

    // 13. Add Bob to Evening Seminar using the same event ID extracted earlier
    await browser.submitForm(
      { event_id: eveningSeminarId!, quantity: "1" },
      "Add to Event",
    );
    expect(browser.containsText("Added to Evening Seminar")).toBe(true);
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 14. Remove Bob from Morning Workshop (first "Remove" form = Morning Workshop)
    await browser.submitForm({}, "Remove");
    expect(browser.containsText("Removed from Morning Workshop")).toBe(true);

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
