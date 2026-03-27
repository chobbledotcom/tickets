/**
 * End-to-end booking flow test.
 *
 * Simulates a complete user journey through the application using TestBrowser,
 * which navigates purely by following links (by text) and submitting forms
 * (by button text) — just like a human would.
 *
 * Flow: setup → login → create event → create question with answers →
 *       assign question to event → create group → add event to group →
 *       visit group page → book ticket (answering question) → view ticket →
 *       admin verifies attendee → download CSV and verify answer
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#lib/db/settings.ts";
import {
  clearTestEncryptionKey,
  createTestDb,
  resetDb,
  setupTestEncryptionKey,
  TestBrowser,
} from "#test-utils";

describe("e2e: full booking flow", () => {
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

  test("setup → create event → group → book → view ticket → admin sees attendee", async () => {
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
    // In production this isn't needed since each HTTP request starts fresh,
    // but in-process tests share the settings singleton.
    settings.invalidateCache();

    // 3. Click through to admin dashboard
    await browser.clickLink("Go to Admin Dashboard");
    // Should redirect to login since we don't have a session yet
    expect(browser.currentHtml).toContain("Login");

    // 4. Log in with admin credentials
    await browser.submitForm(
      {
        username: "admin",
        password: "password",
      },
      "Login",
    );

    // First login lands on the migration page (auto-completes since DB is fresh)
    if (browser.containsText("Migration complete")) {
      await browser.clickLink("Back to dashboard");
    }
    // Should be on admin dashboard now
    expect(browser.containsText("Add Event")).toBe(true);

    // 5. Create an event
    await browser.clickLink("Add Event");
    expect(browser.currentHtml).toContain("Add Event");

    await browser.submitForm(
      {
        name: "Summer Concert",
        description: "A wonderful summer evening of music",
        max_attendees: "100",
        max_quantity: "5",
        fields: ["email"],
      },
      "Create Event",
    );
    // Should be on the dashboard with the new event listed
    expect(browser.containsText("Summer Concert")).toBe(true);

    // 5b. Create a question with answers via /admin/questions
    await browser.visit("/admin/questions");
    expect(browser.containsText("Custom Questions")).toBe(true);

    await browser.submitForm(
      { text: "What is your t-shirt size?" },
      "Add Question",
    );
    expect(browser.containsText("What is your t-shirt size?")).toBe(true);

    // Navigate to the question detail page and add answers
    await browser.clickLink("What is your t-shirt size?");
    await browser.submitForm({ text: "Small" }, "Add Answer");
    await browser.submitForm({ text: "Medium" }, "Add Answer");
    await browser.submitForm({ text: "Large" }, "Add Answer");
    expect(browser.containsText("Small")).toBe(true);
    expect(browser.containsText("Medium")).toBe(true);
    expect(browser.containsText("Large")).toBe(true);

    // 5c. Assign the question to the event
    await browser.visit("/admin/");
    await browser.clickLink("Summer Concert");
    await browser.clickLink("Questions");

    // Select all available questions (checkboxes)
    const questionIds = browser.getCheckboxValues("question_ids");
    expect(questionIds.length).toBeGreaterThan(0);
    await browser.submitForm({ question_ids: questionIds }, "Save");
    expect(browser.containsText("Questions updated")).toBe(true);

    // 6. Navigate to Groups and create a group
    await browser.clickLink("Groups");
    expect(browser.containsText("Add Group")).toBe(true);

    await browser.clickLink("Add Group");
    await browser.submitForm(
      {
        name: "Summer Festival",
      },
      "Create Group",
    );
    // Should redirect to the group detail page or groups list
    expect(browser.containsText("Summer Festival")).toBe(true);

    // 7. Add the event to the group
    //    The group detail page shows "Add Events to Group" with checkboxes
    //    for ungrouped events. Select all of them.
    const eventIds = browser.getCheckboxValues("event_ids");
    expect(eventIds.length).toBeGreaterThan(0);

    await browser.submitForm(
      {
        event_ids: eventIds,
      },
      "Add Selected Events",
    );
    // Should be back on the group detail page with the event now listed
    expect(browser.containsText("Summer Concert")).toBe(true);

    // 8. Visit the public booking page for the group
    //    The group detail page shows a "Public URL" with a link containing /ticket/
    //    The link text shows "localhost/ticket/{slug}"
    const ticketLink = browser.links.find((l) =>
      l.text.includes("localhost/ticket/"),
    );
    expect(ticketLink).toBeTruthy();
    // The link is an absolute URL (https://...), extract the path
    const ticketPath = ticketLink!.href.startsWith("http")
      ? new URL(ticketLink!.href).pathname
      : ticketLink!.href;
    await browser.visit(ticketPath);

    // 9. Book a ticket via the group booking form
    //    For group/multi-ticket pages, quantity fields are per-event
    //    Find the quantity field for our event
    const quantityFields = browser.currentHtml.match(/name="quantity_(\d+)"/);
    const formData: Record<string, string> = {
      name: "Jane Doe",
      email: "jane@example.com",
    };
    // If there's a per-event quantity field, set it
    if (quantityFields) {
      formData[`quantity_${quantityFields[1]}`] = "1";
    }

    // Answer the custom question — find the radio button for "Medium"
    const mediumMatch = browser.currentHtml.match(
      /name="(question_\d+)"\s+value="(\d+)"[^>]*>\s*Medium/,
    );
    expect(mediumMatch).toBeTruthy();
    formData[mediumMatch![1]!] = mediumMatch![2]!;

    // Group bookings use "Reserve Tickets" (plural), single events use "Reserve Ticket"
    const reserveButton = browser.containsText("Reserve Tickets")
      ? "Reserve Tickets"
      : "Reserve Ticket";
    await browser.submitForm(formData, reserveButton);
    // Should be on the success page
    expect(browser.containsText("reserved successfully")).toBe(true);

    // 10. Click to view the ticket
    await browser.clickLink("Click here to view your ticket");
    expect(browser.containsText("Summer Concert")).toBe(true);

    // 11. Now go back to admin to verify the attendee shows up
    //     Visit the homepage — since public site is not enabled, it redirects to login
    await browser.visit("/");
    // Either we're already logged in (cookie still valid) and land on admin,
    // or we need to log in again
    if (browser.currentHtml.includes("Login")) {
      await browser.submitForm(
        {
          username: "admin",
          password: "password",
        },
        "Login",
      );
    }

    // 12. On admin dashboard, click the event to see attendees
    await browser.clickLink("Summer Concert");
    expect(browser.containsText("Jane Doe")).toBe(true);
    expect(browser.containsText("jane@example.com")).toBe(true);

    // 13. Download CSV export and verify the question answer is included
    await browser.clickLink("Export CSV");
    const csv = browser.currentHtml;
    // Header should include the question text
    expect(csv).toContain("What is your t-shirt size?");
    // Row should include the selected answer
    const csvLines = csv.split("\n");
    const headerLine = csvLines[0]!;
    const dataLine = csvLines[1]!;
    // Find the column index for our question
    const headers = headerLine.split(",");
    const qColIndex = headers.findIndex((h) =>
      h.includes("What is your t-shirt size?"),
    );
    expect(qColIndex).toBeGreaterThan(-1);
    // Verify the answer in the data row
    const dataCols = dataLine.split(",");
    expect(dataCols[qColIndex]).toBe("Medium");
  });
});
