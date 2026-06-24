/**
 * End-to-end booking flow test.
 *
 * Simulates a complete user journey through the application using TestBrowser,
 * which navigates purely by following links (by text) and submitting forms
 * (by button text) — just like a human would.
 *
 * Flow: setup → login → create listing → create question with answers →
 *       assign question to listing → create group → add listing to group →
 *       visit group page → book ticket (answering question) → view ticket →
 *       admin verifies attendee → download CSV and verify answer
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { RESTORE_CONFIRM_PHRASE } from "#templates/admin/backup.tsx";
import { withLocalStorageEnabled } from "#test-utils";
import {
  invalidateAllCaches,
  setupAndLogin,
  useE2eBrowser,
} from "#test-utils/e2e.ts";

// jscpd:ignore-end

describe("e2e: full booking flow", () => {
  const ctx = useE2eBrowser();

  test("setup → create listing → group → book → view ticket → admin sees attendee", async () => {
    const browser = ctx.browser;
    // 1-4. Set up the fresh install and log in to the admin dashboard.
    await setupAndLogin(browser);

    // 5. Create an listing
    await browser.clickLink("Add Listing");
    expect(browser.currentHtml).toContain("Add Listing");

    await browser.submitForm(
      {
        description: "A wonderful summer evening of music",
        fields: ["email"],
        max_attendees: "100",
        max_quantity: "5",
        name: "Summer Concert",
      },
      "Create Listing",
    );
    // Should be on the dashboard with the new listing listed
    expect(browser.containsText("Summer Concert")).toBe(true);

    // 5b. Create a question with answers via /admin/questions
    await browser.visit("/admin/questions");
    expect(browser.containsText("Custom Questions")).toBe(true);

    // Creating a question redirects straight to its detail page so answers
    // can be added immediately.
    await browser.submitForm(
      { text: "What is your t-shirt size?" },
      "Add Question",
    );
    expect(browser.containsText("What is your t-shirt size?")).toBe(true);

    // Add answers on the question detail page
    await browser.submitForm({ text: "Small" }, "Add Answer");
    await browser.submitForm({ text: "Medium" }, "Add Answer");
    await browser.submitForm({ text: "Large" }, "Add Answer");
    expect(browser.containsText("Small")).toBe(true);
    expect(browser.containsText("Medium")).toBe(true);
    expect(browser.containsText("Large")).toBe(true);

    // 5c. Assign the question to the listing
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

    // 7. Add the listing to the group
    //    The group detail page shows "Add Listings to Group" with checkboxes
    //    for ungrouped listings. Select all of them.
    const listingIds = browser.getCheckboxValues("listing_ids");
    expect(listingIds.length).toBeGreaterThan(0);

    await browser.submitForm(
      {
        listing_ids: listingIds,
      },
      "Add Selected Listings",
    );
    // Should be back on the group detail page with the listing now listed
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
    //    For group/multi-ticket pages, quantity fields are per-listing
    //    Find the quantity field for our listing
    const quantityFields = browser.currentHtml.match(/name="quantity_(\d+)"/);
    const formData: Record<string, string> = {
      email: "jane@example.com",
      name: "Jane Doe",
    };
    // If there's a per-listing quantity field, set it
    if (quantityFields) {
      formData[`quantity_${quantityFields[1]}`] = "1";
    }

    // Answer the custom question — find the radio button for "Medium"
    const mediumMatch = browser.currentHtml.match(
      /name="(question_\d+)"[^>]*value="(\d+)"[^>]*>\s*Medium/,
    );
    expect(mediumMatch).toBeTruthy();
    formData[mediumMatch![1]!] = mediumMatch![2]!;

    await browser.submitForm(formData, "Continue");
    // Should be on the success page
    expect(browser.containsText("Thank you for your order")).toBe(true);

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
          password: "password",
          username: "admin",
        },
        "Login",
      );
    }

    // 12. On admin dashboard, click the listing to see attendees
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

    // ── Backup / Reset / Restore flow ──────────────────────────

    await withLocalStorageEnabled(async () => {
      // 14. Navigate to backup page and create a backup
      await browser.visit("/admin/backup");
      expect(browser.containsText("Database Backup")).toBe(true);
      expect(browser.containsText("Encryption Key")).toBe(true);

      await browser.submitForm({}, "Create Backup Now");
      expect(browser.containsText("Database backup created")).toBe(true);

      // 15. Download the backup zip for later restore
      const downloadLink = browser.links.find((l) =>
        l.text.includes("Download"),
      );
      expect(downloadLink).toBeTruthy();
      const backupZip = await browser.downloadBytes(downloadLink!.href);
      expect(backupZip.length).toBeGreaterThan(0);

      // 16. Reset the database directly and reinitialize schema so this
      //     in-process flow can continue after the destructive reset.
      const { initDb: reinitDb, resetDatabase: resetDb2 } = await import(
        "#shared/db/migrations.ts"
      );
      await resetDb2();
      await reinitDb({ allowMissingSettings: true });
      invalidateAllCaches();

      // 17-19. Set up and log in again on the now-empty database (setupAndLogin
      //         only succeeds if the reset really did make setup available).
      await setupAndLogin(browser);

      // 20. Verify the listing and attendee are gone after reset
      expect(browser.containsText("Summer Concert")).toBe(false);

      // 21. Navigate to backup page and restore from the saved zip
      await browser.visit("/admin/backup");
      await browser.submitFormWithFile(
        "backup_file",
        "backup.zip",
        backupZip,
        {},
        "Upload",
      );
      // Should show the restore confirmation page
      expect(browser.containsText("Confirm Database Restore")).toBe(true);
      expect(browser.containsText("SQL statements")).toBe(true);

      // 22. Confirm the restore
      await browser.submitForm(
        { confirm_identifier: RESTORE_CONFIRM_PHRASE },
        "Restore Database",
      );
      expect(browser.containsText("Database restored from backup")).toBe(true);
      invalidateAllCaches();

      // 23. Log in again (restore wiped sessions)
      await browser.visit("/admin/");
      if (browser.currentHtml.includes("Login")) {
        await browser.submitForm(
          { password: "password", username: "admin" },
          "Login",
        );
      }
      if (browser.containsText("Migration complete")) {
        await browser.clickLink("Back to dashboard");
      }

      // 24. Verify the listing and attendee are back
      expect(browser.containsText("Summer Concert")).toBe(true);
      await browser.clickLink("Summer Concert");
      expect(browser.containsText("Jane Doe")).toBe(true);
      expect(browser.containsText("jane@example.com")).toBe(true);
    });
  });
});
