// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminGet,
  bookAttendee,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  extractInputValue,
  testRequiresAuth,
} from "#test-utils";

// jscpd:ignore-end
describeWithEnv("server (admin attendees) > merge panel", { db: true }, () => {
  describe("merge panel on the Actions tab", () => {
    testRequiresAuth("/admin/attendees/1/actions", {
      setup: async () => {
        const listing = await createTestListing({ maxAttendees: 10 });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "John Doe",
          "john@example.com",
        );
      },
    });

    test("returns 404 for non-existent attendee", async () => {
      const response = await adminGet("/admin/attendees/999/actions");
      expect(response.status).toBe(404);
    });

    test("shows the merge search form without a token param", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Merge Attendee",
        "Search by Ticket Token",
      );
    });

    test("shows error when token not found", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions?token=invalid-token`,
      );
      await expectHtmlResponse(response, 200, "not found");
    });

    test("shows error when token matches same attendee", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "John Doe",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${attendee.id}/actions?token=${encodeURIComponent(
          token,
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Cannot merge an attendee with themselves",
      );
    });

    test("shows merge preview when valid source token provided", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(
        response,
        200,
        "Merge Preview",
        "Jane Doe",
        "John Smith",
        "Merge and Delete Source Attendee",
      );
    });

    test("the token search box focuses when idle and echoes the searched token", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );
      // Idle panel: the search box is the tab's one job, so it takes focus
      // and starts empty.
      const idle = await expectHtmlResponse(
        await adminGet(`/admin/attendees/${target.id}/actions`),
        200,
      );
      expect(idle).toContain(" autofocus");
      expect(extractInputValue(idle, "token")).toBe("");
      // After a successful search the box echoes the token back (so the admin
      // can see what matched) and cedes focus to the decision form.
      const searched = await expectHtmlResponse(
        await adminGet(
          `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
            sourceToken,
          )}`,
        ),
        200,
      );
      expect(searched).not.toContain("autofocus");
      expect(extractInputValue(searched, "token")).toBe(sourceToken);
    });
  });

  describe("merge panel previews (coverage branches)", () => {
    test("shows merge preview with multiline field differences (address differs)", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "",
        "123 Main St",
        "No nuts",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
        1,
        "",
        "456 Oak Ave",
        "Gluten free",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // Multiline fields (address, special_instructions) differ — exercises renderFieldValue(val, true) with same=false
      await expectHtmlResponse(response, 200, "456 Oak Ave", "Gluten free");
    });

    test("shows merge preview when source has empty phone but target does not", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
        1,
        "555-1234",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      // Source has no phone — exercises sourceValue || "—" branch
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows merge preview when source and target have empty email", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      // Empty email covers the `email || ""` branches on both target and source
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "",
      );
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "",
      );
      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      await expectHtmlResponse(response, 200, "Merge Preview");
    });

    test("shows daily listing start_at date in source bookings list", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });
      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const dailyListing = await createTestListing({
        listingType: "daily",
        maxAttendees: 50,
        name: "Daily E",
      });
      const result = await bookAttendee(dailyListing, {
        date: "2026-05-01",
        email: "john@example.com",
        name: "John Smith",
      });
      if (!result.success) throw new Error("createAttendeeAtomic failed");
      const sourceToken = result.attendees[0]!.ticket_token;

      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // start_at is set for daily listings — exercises the b.start_at ? `— date` : "" branch
      await expectHtmlResponse(response, 200, "2026-05-01");
    });

    test("shows moveable booking row without decision column when no conflicts", async () => {
      const listing1 = await createTestListing({ maxAttendees: 10 });
      const listing2 = await createTestListing({
        maxAttendees: 10,
        name: "E2",
      });

      const { attendee: target } = await createTestAttendeeDirect(
        listing1.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing2.id,
        "John Smith",
        "john@example.com",
      );

      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // All bookings are moveable (different listings) — no Decision column rendered
      await expectHtmlResponse(response, 200, "Will be moved");
    });

    test("shows duplicate booking status when same listing with identical metadata", async () => {
      const listing = await createTestListing({ maxAttendees: 10 });

      const { attendee: target } = await createTestAttendeeDirect(
        listing.id,
        "Jane Doe",
        "jane@example.com",
      );
      const { token: sourceToken } = await createTestAttendeeDirect(
        listing.id,
        "John Smith",
        "john@example.com",
      );

      const response = await adminGet(
        `/admin/attendees/${target.id}/actions?token=${encodeURIComponent(
          sourceToken,
        )}`,
      );
      // Same listing, same qty/price/checked_in/refunded — classified as "duplicate"
      await expectHtmlResponse(response, 200, "Duplicate");
    });
  });
});
