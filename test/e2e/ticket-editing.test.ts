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
import { invalidateEventsCache } from "#shared/db/events.ts";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
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
  const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(
    new RegExp(
      `<option[^>]*\\bvalue="(\\d+)"[^>]*>\\s*${escaped}\\s*<\\/option>`,
    ),
  );
  return match?.[1] ?? null;
};

/**
 * Navigate to the attendee edit page from the current event detail page.
 * The event page has both an "Edit event" link and "Edit attendee" links.
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
    // 1. Setup: create admin, log in, create event with two attendees
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

    // Create event
    await browser.clickLink("Add Event");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Art Class" },
      "Create Event",
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

    // 2. Check Alice in — the "Check in" button on the event page
    //    Alice appears first alphabetically, so her Check in button comes first.
    await browser.submitForm({}, "Check in");
    expect(browser.containsText("Checked Alice Smith in")).toBe(true);

    // 3. Navigate to Alice's edit page and update her contact info
    await visitFirstAttendeeEditPage(browser);
    expect(browser.containsText("Alice Smith")).toBe(true);

    // Verify her current booking details on the edit page:
    // The Event Registrations table shows quantity and checked-in badge
    expect(browser.currentHtml).toContain("Checked in");

    await browser.submitForm(
      {
        address: "42 Oak Street",
        email: "alice.johnson@example.com",
        name: "Alice Johnson",
        phone: "+449876543210",
        special_instructions: "Needs wheelchair access",
      },
      "Save Attendee",
    );
    // 4. Save returns to the same edit form, with the flash shown inside it.
    expect(browser.containsText("Updated Alice Johnson")).toBe(true);
    expect(browser.containsText("Alice Johnson")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(false);

    // 5. The edit form shows the saved fields and the preserved booking.
    expect(browser.currentHtml).toContain("alice.johnson@example.com");
    expect(browser.currentHtml).toContain("+449876543210");
    expect(browser.currentHtml).toContain("42 Oak Street");
    expect(browser.currentHtml).toContain("Needs wheelchair access");
    // Booking preserved: quantity still 2 and still checked in
    expect(browser.currentHtml).toContain('value="2"');
    expect(browser.currentHtml).toContain("Checked in");

    // 6. Go back to the event page and navigate to Bob's edit page.
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
      "Save Attendee",
    );
    expect(browser.containsText("Updated Robert Jones")).toBe(true);

    // 8. Save returns to Bob's edit form; his renamed details and intact
    //    booking are shown there directly, so we assert on the current page.
    expect(browser.containsText("Robert Jones")).toBe(true);
    expect(browser.containsText("Bob Jones")).toBe(false);
    expect(browser.currentHtml).toContain("robert@example.com");
    expect(browser.currentHtml).toContain("+441111222333");
    expect(browser.currentHtml).toContain("7 Pine Avenue");
    expect(browser.currentHtml).toContain("Vegetarian meals");
    // Booking preserved: quantity still 1, not checked in
    expect(browser.currentHtml).toContain('value="1"');
    expect(browser.currentHtml).not.toContain("Checked in");

    // 9. Final verification: go back to event page and confirm both
    //    attendees have their updated names and original booking properties
    await browser.visit("/admin/");
    await browser.clickLink("Art Class");
    expect(browser.containsText("Alice Johnson")).toBe(true);
    expect(browser.containsText("Robert Jones")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(false);
    expect(browser.containsText("Bob Jones")).toBe(false);
  });

  test("create events → add attendees → move attendees between events", async () => {
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
    expect(browser.containsText("Add Event")).toBe(true);

    // 4. Create Event 1: "Morning Workshop"
    await browser.clickLink("Add Event");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Morning Workshop" },
      "Create Event",
    );
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 5. Create Event 2: "Evening Seminar"
    await browser.clickLink("Add Event");
    await browser.submitForm(
      { max_attendees: "50", max_quantity: "5", name: "Evening Seminar" },
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

    // The Event Registrations line editor shows Alice's existing booking as a
    // <select> with Morning Workshop pre-selected (the new form edits the event
    // via a dropdown rather than linking out to the event page).
    expect(browser.currentHtml).toContain("selected>Morning Workshop</option>");
    expect(browser.containsText("Morning Workshop")).toBe(true);

    // 8. Extract the Evening Seminar event ID from the line-event select options.
    //    The unified edit form renders an <option> per active event inside
    //    each line's event <select>; the option value is the numeric event id.
    const eveningSeminarId = extractEventIdFromSelect(
      browser.currentHtml,
      "Evening Seminar",
    );
    expect(eveningSeminarId).toBeTruthy();

    // 9. Add Alice to Evening Seminar via the unified form. The form
    //    already has one existing line (Morning Workshop) plus a trailing
    //    blank line at index 1. Fill in the blank slot's event id and
    //    quantity, then submit "Save Attendee".
    await browser.submitForm(
      {
        [`line_event_id_1`]: eveningSeminarId!,
        [`line_quantity_1`]: "1",
        name: "Alice Smith",
      },
      "Save Attendee",
    );
    // Save returns to the same edit form, with the flash shown inside it.
    expect(browser.containsText("Updated Alice Smith")).toBe(true);

    // Both events are now registered — visible in the form's line editor.
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 10. Remove Alice from Morning Workshop. The first "Remove" button
    //     targets the first existing line (Morning Workshop, lower event id).
    //     Removal is now a pure form-state edit — it drops the line and
    //     re-renders; the deletion is committed when the whole attendee is
    //     saved, so no other in-progress edits are lost to a mid-edit write.
    await browser.submitForm({}, "Remove");
    await browser.submitForm({ name: "Alice Smith" }, "Save Attendee");
    expect(browser.containsText("Updated Alice Smith")).toBe(true);

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
      {
        [`line_event_id_1`]: eveningSeminarId!,
        [`line_quantity_1`]: "1",
        name: "Bob Jones",
      },
      "Save Attendee",
    );
    expect(browser.containsText("Updated Bob Jones")).toBe(true);

    // Both events are registered — visible in the form's line editor.
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // 14. Remove Bob from Morning Workshop (first "Remove" button = Morning
    //     Workshop), then save to commit the removal.
    await browser.submitForm({}, "Remove");
    await browser.submitForm({ name: "Bob Jones" }, "Save Attendee");
    expect(browser.containsText("Updated Bob Jones")).toBe(true);

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
