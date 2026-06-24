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

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addAttendee,
  createListing,
  gotoListing,
  openAttendeeEditor,
  setupAndLogin,
  useE2eBrowser,
} from "#test-utils/e2e.ts";

// jscpd:ignore-end

describe("e2e: ticket editing flow", () => {
  const ctx = useE2eBrowser();

  test("edit attendee contact info preserves bookings", async () => {
    const browser = ctx.browser;
    // 1. Set up, log in, and create a listing with two attendees.
    await setupAndLogin(browser);
    await createListing(browser, { name: "Art Class" });

    // Add Alice with quantity 2
    await addAttendee(browser, { name: "Alice Smith", quantity: "2" });
    expect(browser.containsText("Added Alice Smith")).toBe(true);

    // Add Bob with quantity 1
    await addAttendee(browser, { name: "Bob Jones", quantity: "1" });
    expect(browser.containsText("Added Bob Jones")).toBe(true);

    // 2. Check Alice in — the "Check in" button on the listing page.
    //    Alice appears first alphabetically, so her Check in button comes first.
    await browser.submitForm({}, "Check in");
    expect(browser.containsText("Checked Alice Smith in")).toBe(true);

    // 3. Navigate to Alice's edit page and update her contact info
    await openAttendeeEditor(browser);
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
      "Save Attendee",
    );
    // 4. Save returns to the same edit form, with the flash shown inside it.
    expect(browser.containsText("Updated Alice Johnson")).toBe(true);
    expect(browser.containsText("Alice Johnson")).toBe(true);
    // The editable name field now holds the new name. The old name lingers only
    // in the attendee's activity log — a historical record that legitimately
    // shows "Attendee 'Alice Smith' added manually" — so assert against the
    // field value rather than the whole page.
    expect(browser.currentHtml).toContain('value="Alice Johnson"');
    expect(browser.currentHtml).not.toContain('value="Alice Smith"');

    // 5. The edit form shows the saved fields and the preserved booking.
    expect(browser.currentHtml).toContain("alice.johnson@example.com");
    expect(browser.currentHtml).toContain("+449876543210");
    expect(browser.currentHtml).toContain("42 Oak Street");
    expect(browser.currentHtml).toContain("Needs wheelchair access");
    // Booking preserved: quantity still 2 and still checked in
    expect(browser.currentHtml).toContain('value="2"');
    expect(browser.currentHtml).toContain("Checked in");

    // 6. Go back to the listing page and navigate to Bob's edit page.
    //    Alice (now Alice Johnson) appears first alphabetically, Bob second.
    await gotoListing(browser, "Art Class");

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
    // As with Alice, the old name survives only in the activity-log history, so
    // assert the editable name field rather than the whole page.
    expect(browser.currentHtml).toContain('value="Robert Jones"');
    expect(browser.currentHtml).not.toContain('value="Bob Jones"');
    expect(browser.currentHtml).toContain("robert@example.com");
    expect(browser.currentHtml).toContain("+441111222333");
    expect(browser.currentHtml).toContain("7 Pine Avenue");
    expect(browser.currentHtml).toContain("Vegetarian meals");
    // Booking preserved: quantity still 1, not checked in
    expect(browser.currentHtml).toContain('value="1"');
    expect(browser.currentHtml).not.toContain("Checked in");

    // 9. Final verification: go back to listing page and confirm both
    //    attendees have their updated names and original booking properties
    await gotoListing(browser, "Art Class");
    expect(browser.containsText("Alice Johnson")).toBe(true);
    expect(browser.containsText("Robert Jones")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(false);
    expect(browser.containsText("Bob Jones")).toBe(false);
  });

  test("create listings → add attendees → move attendees between listings", async () => {
    const browser = ctx.browser;
    await setupAndLogin(browser);

    // Create two listings, capturing their ids for the editor's qty_<id> fields.
    const morningWorkshopId = await createListing(browser, {
      name: "Morning Workshop",
    });
    const eveningSeminarId = await createListing(browser, {
      name: "Evening Seminar",
    });

    // Add Alice as the first attendee of Morning Workshop.
    await gotoListing(browser, "Morning Workshop");
    expect(browser.containsText("Add Attendee")).toBe(true);
    await addAttendee(browser, { name: "Alice Smith", quantity: "1" });
    expect(browser.containsText("Added Alice Smith")).toBe(true);
    expect(browser.containsText("Alice Smith")).toBe(true);

    // Navigate to Alice's edit page. The Listing Registrations editor shows one
    // quantity box per listing — her Morning Workshop booking plus an empty
    // Evening Seminar row.
    await openAttendeeEditor(browser);
    expect(browser.containsText("Alice Smith")).toBe(true);
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // Add Alice to Evening Seminar by setting its quantity. submitForm also
    // re-submits the visible Morning Workshop quantity, so that booking stays.
    await browser.submitForm(
      { name: "Alice Smith", [`qty_${eveningSeminarId}`]: "1" },
      "Save Attendee",
    );
    expect(browser.containsText("Updated Alice Smith")).toBe(true);
    // Both listings are now registered — visible in the form's line editor.
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // Remove Alice from Morning Workshop by zeroing its quantity; the save
    // deletes that booking while keeping the Evening Seminar one.
    await browser.submitForm(
      { name: "Alice Smith", [`qty_${morningWorkshopId}`]: "0" },
      "Save Attendee",
    );
    expect(browser.containsText("Updated Alice Smith")).toBe(true);

    // Back on Morning Workshop, Alice is gone. Add Bob as the second attendee.
    await gotoListing(browser, "Morning Workshop");
    expect(browser.containsText("Alice Smith")).toBe(false);
    await addAttendee(browser, { name: "Bob Jones", quantity: "1" });
    expect(browser.containsText("Added Bob Jones")).toBe(true);
    expect(browser.containsText("Bob Jones")).toBe(true);
    // Alice was already moved to Evening Seminar — she must not appear here.
    expect(browser.containsText("Alice Smith")).toBe(false);

    // Navigate to Bob's edit page and add him to Evening Seminar too.
    await openAttendeeEditor(browser);
    expect(browser.containsText("Bob Jones")).toBe(true);
    expect(browser.containsText("Morning Workshop")).toBe(true);
    await browser.submitForm(
      { name: "Bob Jones", [`qty_${eveningSeminarId}`]: "1" },
      "Save Attendee",
    );
    expect(browser.containsText("Updated Bob Jones")).toBe(true);
    expect(browser.containsText("Morning Workshop")).toBe(true);
    expect(browser.containsText("Evening Seminar")).toBe(true);

    // Remove Bob from Morning Workshop by zeroing its quantity, then save.
    await browser.submitForm(
      { name: "Bob Jones", [`qty_${morningWorkshopId}`]: "0" },
      "Save Attendee",
    );
    expect(browser.containsText("Updated Bob Jones")).toBe(true);

    // Morning Workshop is now empty — neither Alice nor Bob appear.
    await gotoListing(browser, "Morning Workshop");
    expect(browser.containsText("Alice Smith")).toBe(false);
    expect(browser.containsText("Bob Jones")).toBe(false);

    // Evening Seminar has both attendees.
    await gotoListing(browser, "Evening Seminar");
    expect(browser.containsText("Alice Smith")).toBe(true);
    expect(browser.containsText("Bob Jones")).toBe(true);
  });
});
