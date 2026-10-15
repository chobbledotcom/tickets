/**
 * How the attendees browser rolls an attendee's bookings into one row, and how
 * it pages the grouped rows.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEES_PAGE_SIZE } from "#db/attendees/queries.ts";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import { adminGet } from "#test-utils/session.ts";
import { makeListing, seedListingFilterPair } from "./helpers.ts";

describeWithEnv("the attendees browser rows", { db: true }, () => {
  describe("grouped rows", () => {
    test("groups an attendee's bookings into one row, listings in display order", async () => {
      const beta = await makeListing("Beta Show");
      const alpha = await makeListing("Alpha Show");
      // Booked in reverse-alphabetical order; the cell must follow the
      // listings page order (no-date standard listings sort by name).
      const attendee = await createMultiBookingAttendee(
        "CarolMulti",
        "carol@example.com",
        [{ listingId: beta.id }, { listingId: alpha.id }],
      );

      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      assertStringIncludes(
        html,
        '<span class="listings-cell" title="Alpha Show, Beta Show">' +
          `<a href="/admin/listing/${alpha.id}">Alpha Show</a>, ` +
          `<a href="/admin/listing/${beta.id}">Beta Show</a></span>`,
      );
      // One grouped row: the attendee's edit link renders exactly once.
      const nameLinks = html.match(
        new RegExp(`href="/admin/attendees/${attendee.id}"`, "g"),
      );
      expect(nameLinks?.length).toBe(1);
    });

    test("sums the ticket quantity across a grouped row's bookings", async () => {
      const first = await makeListing("First Show");
      const second = await makeListing("Second Show");
      await createMultiBookingAttendee("QtyPerson", "qty@example.com", [
        { listingId: first.id, quantity: 2 },
        { listingId: second.id, quantity: 3 },
      ]);

      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      assertStringIncludes(html, '<td class="col-quantity">5</td>');
    });
  });

  describe("paging", () => {
    test("a page beyond the last one has no attendees on it", async () => {
      await seedListingFilterPair();
      await expectHtml(await adminGet("/admin/attendees?page=50"), {
        notContains: ["AliceOne", "BobTwo"],
      });
    });

    test("a page number that is not a number is treated as the first page", async () => {
      await seedListingFilterPair();
      await expectHtml(await adminGet("/admin/attendees?page=abc"), {
        contains: ["AliceOne"],
      });
    });

    test("clamps a non-positive page number to the first page", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");

      const response = await adminGet("/admin/attendees?page=0");
      const html = await response.text();
      assertStringIncludes(html, "Alice");
      // First page has no previous link.
      assert(
        !html.includes('rel="prev"'),
        "the value should not contain the searched item",
      );
    });

    test("shows the whole page with no paging links when the attendees exactly fill it", async () => {
      const listing = await makeListing("Full Page", ATTENDEES_PAGE_SIZE * 2);
      // Created first = oldest = the row a broken hasNext would trim off.
      await createTestAttendeeDirect(
        listing.id,
        "OldestExact",
        "oldest-exact@example.com",
      );
      await seedFillerAttendees(listing.id, ATTENDEES_PAGE_SIZE - 1);

      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      assertStringIncludes(html, "OldestExact");
      assert(
        !html.includes('rel="next"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('rel="prev"'),
        "the value should not contain the searched item",
      );
    });

    test("paginates by attendee, keeping a grouped row's bookings together", async () => {
      const listing = await makeListing("Big Listing", ATTENDEES_PAGE_SIZE * 2);
      const other = await makeListing("Other Show", ATTENDEES_PAGE_SIZE * 2);
      // Oldest registration is created first, so it lands on the second page —
      // with BOTH of its booking lines, despite the page-size cut falling on it.
      await createMultiBookingAttendee("OldestPerson", "oldest@example.com", [
        { listingId: listing.id },
        { listingId: other.id },
      ]);
      await seedFillerAttendees(listing.id, ATTENDEES_PAGE_SIZE);

      // Page 0: newest PAGE_SIZE attendees, a next link, no previous link.
      const first = await adminGet("/admin/attendees");
      const firstHtml = await first.text();
      assert(
        !firstHtml.includes("OldestPerson"),
        "the value should not contain the searched item",
      );
      assertStringIncludes(firstHtml, 'rel="next"');
      assertStringIncludes(firstHtml, 'href="/admin/attendees?page=1"');
      assert(
        !firstHtml.includes('rel="prev"'),
        "the value should not contain the searched item",
      );

      // Page 1: the remaining oldest attendee — one row carrying both
      // listings — a previous link, no next link.
      const second = await adminGet("/admin/attendees?page=1");
      const secondHtml = await second.text();
      assertStringIncludes(secondHtml, "OldestPerson");
      assertStringIncludes(secondHtml, 'title="Big Listing, Other Show"');
      assertStringIncludes(secondHtml, 'rel="prev"');
      assert(
        !secondHtml.includes('rel="next"'),
        "the value should not contain the searched item",
      );
    });
  });
});
