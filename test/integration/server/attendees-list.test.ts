import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEES_PAGE_SIZE } from "#shared/db/attendees/queries.ts";
import { createSystemNote } from "#shared/db/notes/queries.ts";
import { attendeeNotes } from "#shared/db/notes/target.ts";
import {
  assertAdminHtml,
  expectHtml,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import {
  createMultiBookingAttendee,
  createTestAttendeeDirect,
} from "#test-utils/db-helpers/attendees.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminGet } from "#test-utils/session.ts";

/** Create a standard listing with plenty of capacity */
const makeListing = (name: string, maxAttendees = 100) =>
  createTestListing({
    maxAttendees,
    name,
    thankYouUrl: "https://example.com",
  });

const seedListingFilterPair = async () => {
  const first = await makeListing("First Listing");
  const second = await makeListing("Second Listing");
  await createTestAttendeeDirect(first.id, "AliceOne", "a1@example.com");
  await createTestAttendeeDirect(second.id, "BobTwo", "b2@example.com");
  return { first, second };
};

const expectFallsBackToAllListings = async (
  listingParam: (firstId: number) => string,
) => {
  const { first } = await seedListingFilterPair();
  await expectHtml(
    await adminGet(`/admin/attendees?listing=${listingParam(first.id)}`),
    { contains: ["AliceOne", "BobTwo"] },
  );
};

describeWithEnv("server (admin attendees list)", { db: true }, () => {
  describe("GET /admin/attendees", () => {
    testRequiresAuth("/admin/attendees");

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

    test("lists the newest registration first by default", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");

      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      // Bob registered last, so appears above Alice.
      expect(html.indexOf("Bob")).toBeLessThan(html.indexOf("Alice"));
    });

    test("lists the oldest registration first when sort=oldest", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");
      await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");

      const response = await adminGet("/admin/attendees?sort=oldest");
      const html = await response.text();
      expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("Bob"));
    });

    test("filters the table to a single listing", async () => {
      const { first } = await seedListingFilterPair();

      await expectHtml(await adminGet(`/admin/attendees?listing=${first.id}`), {
        contains: ["AliceOne", `selected value="${first.id}"`],
        notContains: ["BobTwo"],
      });
    });

    test("falls back to all listings for an unknown listing filter", async () => {
      await expectFallsBackToAllListings(() => "999999");
    });

    test("falls back to all listings for a malformed listing filter", async () => {
      await expectFallsBackToAllListings((id) => `${id}x`);
    });

    test("flags a deactivated listing in the filter dropdown", async () => {
      const listing = await makeListing("Retired Show");
      await deactivateTestListing(listing.id);

      await assertAdminHtml("/admin/attendees", "Retired Show (deactivated)");
    });

    test("shows an empty state when no attendees exist", async () => {
      await makeListing("Empty Listing");

      await assertAdminHtml("/admin/attendees", "No attendees yet");
    });

    test("clamps a non-positive page number to the first page", async () => {
      const listing = await makeListing("Gala Night");
      await createTestAttendeeDirect(listing.id, "Alice", "alice@example.com");

      const response = await adminGet("/admin/attendees?page=0");
      const html = await response.text();
      expect(html).toContain("Alice");
      // First page has no previous link.
      expect(html).not.toContain('rel="prev"');
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
      expect(html).toContain("OldestExact");
      expect(html).not.toContain('rel="next"');
      expect(html).not.toContain('rel="prev"');
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
      expect(firstHtml).not.toContain("OldestPerson");
      expect(firstHtml).toContain('rel="next"');
      expect(firstHtml).toContain('href="/admin/attendees?page=1"');
      expect(firstHtml).not.toContain('rel="prev"');

      // Page 1: the remaining oldest attendee — one row carrying both
      // listings — a previous link, no next link.
      const second = await adminGet("/admin/attendees?page=1");
      const secondHtml = await second.text();
      expect(secondHtml).toContain("OldestPerson");
      expect(secondHtml).toContain('title="Big Listing, Other Show"');
      expect(secondHtml).toContain('rel="prev"');
      expect(secondHtml).not.toContain('rel="next"');
    });

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
      expect(html).toContain(
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
      expect(html).toContain('<td class="col-quantity">5</td>');
    });

    test("a listing filter matches attendees but still shows their other listings", async () => {
      const booked = await makeListing("Booked Show");
      const also = await makeListing("Also Booked");
      const unrelated = await makeListing("Unrelated Show");
      await createMultiBookingAttendee("DoubleBooker", "db@example.com", [
        { listingId: booked.id },
        { listingId: also.id },
      ]);
      await createTestAttendeeDirect(
        unrelated.id,
        "OtherPerson",
        "other@example.com",
      );

      const response = await adminGet(`/admin/attendees?listing=${booked.id}`);
      const html = await response.text();
      expect(html).toContain("DoubleBooker");
      // The matched attendee's full listing list renders, filter or not.
      expect(html).toContain('title="Also Booked, Booked Show"');
      expect(html).not.toContain("OtherPerson");
    });
  });

  describe("type filter", () => {
    const makeDaily = (name: string) =>
      createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maxAttendees: 100,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        name,
        thankYouUrl: "https://example.com",
      });

    /** One attendee on each of a standard, daily, and purchase-only listing. */
    const seedTypes = async () => {
      const standard = await makeListing("Std Show");
      const daily = await makeDaily("Day Pass");
      const merch = await createTestListing({
        maxAttendees: 100,
        name: "Tote Bag",
        purchaseOnly: true,
        thankYouUrl: "https://example.com",
      });
      await createTestAttendeeDirect(standard.id, "StdGoer", "s@example.com");
      await createTestAttendeeDirect(daily.id, "DailyGoer", "d@example.com");
      await createTestAttendeeDirect(merch.id, "MerchBuyer", "m@example.com");
      return { daily, merch, standard };
    };

    test("filters to standard listings (singular heading)", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=standard");
      const html = await response.text();
      expect(html).toContain("StdGoer");
      expect(html).not.toContain("DailyGoer");
      expect(html).not.toContain("MerchBuyer");
      expect(html).toContain("Showing 1 attendee for");
      expect(html).toContain("<strong>Standard</strong>");
    });

    test("filters to daily listings (plural heading)", async () => {
      const { daily } = await seedTypes();
      await createTestAttendeeDirect(daily.id, "DailyTwo", "d2@example.com");
      const response = await adminGet("/admin/attendees?type=daily");
      const html = await response.text();
      expect(html).toContain("DailyGoer");
      expect(html).toContain("DailyTwo");
      expect(html).not.toContain("StdGoer");
      expect(html).toContain("Showing 2 attendees for");
      expect(html).toContain("<strong>Daily</strong>");
    });

    test("filters to purchase-only listings", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=purchase-only");
      const html = await response.text();
      expect(html).toContain("MerchBuyer");
      expect(html).not.toContain("StdGoer");
      expect(html).toContain("<strong>No check-in</strong>");
    });

    test("shows the type filter bar when several types exist", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      expect(html).toContain("Showing:");
      expect(html).toContain('href="/admin/attendees?type=daily"');
      expect(html).toContain('href="/admin/attendees?type=purchase-only"');
    });

    test("hides the type filter bar when only one type exists", async () => {
      const listing = await makeListing("Solo");
      await createTestAttendeeDirect(listing.id, "Solo", "solo@example.com");
      const response = await adminGet("/admin/attendees");
      const html = await response.text();
      expect(html).not.toContain("Showing:");
    });

    test("treats an unknown type as 'all'", async () => {
      await seedTypes();
      const response = await adminGet("/admin/attendees?type=bogus");
      const html = await response.text();
      expect(html).toContain("StdGoer");
      expect(html).toContain("DailyGoer");
      expect(html).toContain("MerchBuyer");
    });

    test("a specific listing filter overrides the type filter", async () => {
      const { standard } = await seedTypes();
      const response = await adminGet(
        `/admin/attendees?type=daily&listing=${standard.id}`,
      );
      const html = await response.text();
      expect(html).toContain("StdGoer"); // the listing wins over the type
      expect(html).not.toContain("DailyGoer");
    });

    test("shows nothing for a type with no listings", async () => {
      const listing = await makeListing("Only Standard");
      await createTestAttendeeDirect(listing.id, "Lonely", "l@example.com");
      const response = await adminGet("/admin/attendees?type=daily");
      const html = await response.text();
      expect(html).toContain("No attendees yet");
      expect(html).not.toContain("Lonely");
    });

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
