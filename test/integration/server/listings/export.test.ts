// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { saveAttendeeAnswers } from "#db/questions/attendee-answers/save.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import {
  expectCsvDownloadHeaders,
  fetchListingExportCsv,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  adminFormPost,
  adminGet,
  setupListingAndLogin,
} from "#test-utils/session.ts";

// jscpd:ignore-end

describeWithEnv("server listings > export", { db: true }, () => {
  describe("GET /admin/listing/:id/export", () => {
    testRequiresAuth("/admin/listing/1/export", {
      setup: async () => {
        await createTestListing({
          maxAttendees: 100,
          thankYouUrl: "https://example.com",
        });
      },
    });

    test("returns 404 for non-existent listing", async () => {
      const response = await adminGet("/admin/listing/999/export");
      expect(response.status).toBe(404);
    });

    test("returns CSV with correct headers when authenticated", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1/export", {
        cookie: cookie,
      });
      expectCsvDownloadHeaders(response, ".csv");
    });

    test("returns CSV with attendee data", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Jane Smith",
        "jane@example.com",
      );

      const csv = await fetchListingExportCsv(listing.id, cookie);
      expect(csv).toContain(
        "Name,Email,Phone,Address,Special Instructions,Quantity,Registered",
      );
      expect(csv).toContain("John Doe");
      expect(csv).toContain("john@example.com");
      expect(csv).toContain("Jane Smith");
      expect(csv).toContain("jane@example.com");
    });

    test("returns CSV with Checked In column", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "John Doe",
        "john@example.com",
      );

      // Check in the attendee
      await adminFormPost(
        `/admin/listing/${listing.id}/attendee/${attendee.id}/checkin`,
        {},
      );

      const csv = await fetchListingExportCsv(listing.id, cookie);
      expect(csv).toContain(",Checked In");
      // John Doe is checked in
      expect(csv).toContain("John Doe");
      expect(csv).toContain(",Yes");
    });

    test("returns CSV rows in the order the roster shows them", async () => {
      // Registration order (Mid, Alpha, Zulu) differs from name order, so the
      // chosen order and the table's own order name three different rows.
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });
      for (const name of ["Mid Person", "Alpha Person", "Zulu Person"]) {
        await createTestAttendee(
          listing.id,
          listing.slug,
          name,
          `${name.toLowerCase().replace(" ", ".")}@example.com`,
        );
      }

      /** The names in the order their rows appear in the CSV. */
      const shownOrder = (csv: string): string[] =>
        ["Mid Person", "Alpha Person", "Zulu Person"]
          .map((name) => ({ at: csv.indexOf(name), name }))
          .sort((first, second) => first.at - second.at)
          .map(({ name }) => name);

      // The chosen registration order is honoured.
      const oldest = await fetchListingExportCsv(
        listing.id,
        cookie,
        "?sort=oldest",
      );
      expect(shownOrder(oldest)).toEqual([
        "Mid Person",
        "Alpha Person",
        "Zulu Person",
      ]);
      const newest = await fetchListingExportCsv(
        listing.id,
        cookie,
        "?sort=newest",
      );
      expect(shownOrder(newest)).toEqual([
        "Zulu Person",
        "Alpha Person",
        "Mid Person",
      ]);
      // No sort chosen: the table's own date-and-name order applies, here by
      // name because no booking carries a date.
      const byName = await fetchListingExportCsv(listing.id, cookie);
      expect(shownOrder(byName)).toEqual([
        "Alpha Person",
        "Mid Person",
        "Zulu Person",
      ]);
      // The download's name carries no day when none was chosen.
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        {
          cookie,
        },
      );
      expect(response.headers.get("content-disposition")).toMatch(
        /filename="[^"]*_attendees\.csv"/,
      );
    });

    test("sanitizes slug for filename", async () => {
      const { cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        name: "Test Listing Special",
        thankYouUrl: "https://example.com",
      });

      const response = await awaitTestRequest("/admin/listing/1/export", {
        cookie: cookie,
      });
      const disposition = response.headers.get("content-disposition");
      // Non-alphanumeric characters are replaced with underscores in filename sanitization
      expect(disposition).toContain("Test_Listing_Special");
    });

    test("CSV export includes question columns when listing has questions", async () => {
      const { listing, cookie } = await setupListingAndLogin({
        maxAttendees: 100,
        thankYouUrl: "https://example.com",
      });

      // Create attendee BEFORE assigning questions (avoids form validation)
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "CSV Q User",
        "csvq@test.com",
      );

      // Create question, answers, and assign to listing
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Shirt Size",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await listingQuestions.setIds(listing.id, [q.id]);
      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const csv = await fetchListingExportCsv(listing.id, cookie);
      expect(csv).toContain("Shirt Size");
      expect(csv).toContain("Small");
    });
  });
});
