// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  answersTable,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectCsvDownloadHeaders,
  setupListingAndLogin,
  testRequiresAuth,
} from "#test-utils";

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

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        {
          cookie: cookie,
        },
      );
      const csv = await response.text();
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

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        {
          cookie: cookie,
        },
      );
      const csv = await response.text();
      expect(csv).toContain(",Checked In");
      // John Doe is checked in
      expect(csv).toContain("John Doe");
      expect(csv).toContain(",Yes");
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
      await setListingQuestions(listing.id, [q.id]);
      await saveAttendeeAnswers(new Map([[attendee.id, [a1.id]]]));

      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/export`,
        { cookie },
      );
      const csv = await response.text();
      expect(csv).toContain("Shirt Size");
      expect(csv).toContain("Small");
    });
  });
});
