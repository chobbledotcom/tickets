/**
 * The attendees browser page: who may open it, what a rendered page shows,
 * and the sort order of the table.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { createSystemNote } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import { assertAdminHtml, testRequiresAuth } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";
import { makeListing } from "./helpers.ts";

/** Alice books first, Bob second, so the two sort orders read differently. */
const seedRegistrationPair = async (): Promise<void> => {
  const listing = await makeListing("Gala Night");
  await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
  await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");
};

describeWithEnv("the attendees browser page", { db: true }, () => {
  describe("GET /admin/attendees", () => {
    testRequiresAuth("/admin/attendees");

    test("offers the export at its own address", async () => {
      await seedRegistrationPair();
      const html = await (await adminGet("/admin/attendees")).text();
      expect(html).toContain("/admin/attendees/csv");
    });

    test("offers no check-in filter, which this page does not do", async () => {
      await seedRegistrationPair();
      const html = await (await adminGet("/admin/attendees")).text();
      // The check-in bar links carry filter=in / filter=out when offered.
      expect(html).not.toContain("filter=in");
      expect(html).not.toContain("filter=out");
    });

    test("drops a date from the address, which this page does not use", async () => {
      await seedRegistrationPair();
      const html = await (
        await adminGet("/admin/attendees?date=2026-01-01")
      ).text();
      // A page that took dates would carry the chosen one through its own
      // links and form fields; this one has no date control, so it forgets it.
      expect(html).toContain("Alice");
      expect(html).not.toContain("2026-01-01");
    });

    test("renders the attendees page with the registration", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");

      await assertAdminHtml(
        "/admin/attendees",
        'href="/admin/attendees/new"',
        "Alice",
        "Gala Night",
      );
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      expect(html).not.toContain("<h1>Attendees</h1>");
    });

    test("shows an empty state when no attendees exist", async () => {
      await makeListing("Empty Listing");

      await assertAdminHtml("/admin/attendees", "No attendees yet");
    });

    test("flags a deactivated listing in the filter dropdown", async () => {
      // A second listing keeps the dropdown rendered (one listing hides it).
      await makeListing("Live Show");
      const listing = await makeListing("Retired Show");
      await deactivateTestListing(listing.id);

      await assertAdminHtml("/admin/attendees", "Retired Show (deactivated)");
    });
  });

  describe("the sort order", () => {
    test("lists the newest registration first by default", async () => {
      await seedRegistrationPair();
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      // Bob registered last, so appears above Alice.
      expect(html.indexOf("Bob")).toBeLessThan(html.indexOf("Alice"));
    });

    test("lists the oldest registration first when sort=oldest", async () => {
      await seedRegistrationPair();
      const response = await adminGet("/admin/attendees?sort=oldest");
      const html = await response.text();
      expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("Bob"));
    });

    test("falls back to newest first when the sort is not one we know", async () => {
      await seedRegistrationPair();
      const response = await adminGet("/admin/attendees?sort=sideways");
      const html = await response.text();
      expect(html.indexOf("Bob")).toBeLessThan(html.indexOf("Alice"));
    });
  });

  describe("attendee notes", () => {
    test("surfaces an expandable notes summary when a listed attendee has a note", async () => {
      const listing = await makeListing("Gala Night");
      const { attendee } = await createTestAttendeeDirect(
        listing.id,
        "Alice",
        "alice@example.com",
      );
      await createSystemNote(
        attendeeNotes(attendee.id),
        "Refunded — follow up tomorrow.",
      );

      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      // The decrypted system-note text renders inside the summary, and the
      // attendee's name links to their edit page — proving the notes-loading
      // path (which derives the owner private key only once notes exist) ran.
      expect(html).toContain("1 attendee has notes");
      expect(html).toContain("Refunded — follow up tomorrow.");
      expect(html).toContain('href="/admin/attendees/');
    });
  });
});
