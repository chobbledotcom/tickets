import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { seedListingWithAttendees } from "#test/integration/server/bulk-email/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminGet, createTestManagerSession } from "#test-utils/session.ts";

describeWithEnv("server bulk email > links", { db: true }, () => {
  describe("attendee page Email link", () => {
    test("owners see a link to email the attendee, carrying their token", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee, token } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
      );
      const html = await (
        await adminGet(`/admin/attendees/${attendee.id}`)
      ).text();
      expect(html).toContain(
        `/admin/emails?attendee=${encodeURIComponent(token)}`,
      );
      expect(html).toContain("Send an email to this attendee");
    });

    test("managers do not see the email link", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
        1,
        "07700 900333",
      );
      const cookie = await createTestManagerSession();
      const html = await (
        await awaitTestRequest(`/admin/attendees/${attendee.id}`, {
          cookie,
        })
      ).text();
      expect(html).not.toContain("/admin/emails?attendee=");
    });

    test("the link is disabled when the attendee has no email", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        name: "Solo",
      });
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Nemo",
        "",
      );
      const html = await (
        await adminGet(`/admin/attendees/${attendee.id}`)
      ).text();
      expect(html).toContain("No email address on file.");
      // Rendered as an inert span, not a clickable link to the email page.
      expect(html).toContain("btn--disabled");
      expect(html).not.toContain("/admin/emails?attendee=");
    });
  });

  describe("listing page Email link", () => {
    /**
     * Whether the action is offered at all — to an owner, and only when
     * somebody left an address — is told by the story
     * `attendees.writing-to-the-people-who-booked`. What stays here is the
     * manager's view of the same page, which no story has an actor for.
     */
    test("managers do not see the email action", async () => {
      const listing = await seedListingWithAttendees();
      const cookie = await createTestManagerSession();
      const html = await (
        await awaitTestRequest(`/admin/listing/${listing.id}/actions`, {
          cookie,
        })
      ).text();
      expect(html).not.toContain("/admin/emails?listing=");
    });
  });
});
