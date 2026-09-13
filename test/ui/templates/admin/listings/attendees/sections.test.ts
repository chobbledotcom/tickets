/** Rendering of the listing roster's sections: the attendee list with its
 * email action, the failed-payments table, and the add-attendee form. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rosterListSetup } from "#routes/admin/listings-view.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import {
  AddAttendeeSection,
  AttendeesSection,
  FailedPaymentsSection,
  filterAttendees,
} from "#templates/admin/listings/attendees.tsx";
import type { RosterListView } from "#templates/admin/listings/types.ts";
import { registerListingTemplateHooks } from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("filterAttendees", () => {
  registerListingTemplateHooks();

  const rows = [
    testAttendee({ checked_in: true, id: 1 }),
    testAttendee({ checked_in: false, id: 2 }),
    testAttendee({ checked_in: false, id: 3, quantity: 0 }),
    testAttendee({ checked_in: true, id: 4, quantity: 0 }),
  ];
  const ids = (filtered: ReturnType<typeof filterAttendees>) =>
    filtered.map((a) => a.id);

  test("all keeps every row, quantity or not", () => {
    expect(ids(filterAttendees(rows, "all"))).toEqual([1, 2, 3, 4]);
  });

  test("in keeps only checked-in tickets", () => {
    expect(ids(filterAttendees(rows, "in"))).toEqual([1]);
  });

  test("out keeps only not-checked-in tickets", () => {
    expect(ids(filterAttendees(rows, "out"))).toEqual([2]);
  });
});

describe("AttendeesSection", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ id: 7, name: "Kayak Hire" });
  const list: RosterListView = {
    setup: rosterListSetup(listing, []),
    state: {
      checkin: "all",
      date: null,
      listingId: null,
      page: 0,
      sort: null,
      type: "all",
    },
  };
  const sectionHtml = (emailDayHref: string | undefined): string =>
    String(
      AttendeesSection({
        allowedDomain: "localhost",
        emailDayHref,
        list,
        phonePrefix: undefined,
        questionData: undefined,
        returnUrl: "/admin/listing/7/attendees",
        tableRows: [attendeeLineRow(testAttendee(), listing)],
      }),
    );

  test("heads the section and omits the listing column it cannot need", () => {
    const html = sectionHtml(undefined);
    expect(html).toContain('<h2 id="attendees">Attendees</h2>');
    // The page is already one listing's roster, so no Listings column.
    expect(html).not.toContain("<th>Listings</th>");
  });

  test("renders the email action only when the compose page would open", () => {
    expect(sectionHtml(undefined)).not.toContain("Email this date's attendees");
    expect(sectionHtml("/admin/emails?mock")).toContain(
      '<a href="/admin/emails?mock">Email this date\'s attendees</a>',
    );
  });
});

describe("FailedPaymentsSection", () => {
  registerListingTemplateHooks();

  const attendee = testAttendee({ id: 9, quantity: 2 });
  const html = String(
    FailedPaymentsSection({ attendees: [attendee], listingId: 7 }),
  );

  test("heads the section and counts the unresolved rows", () => {
    expect(html).toContain('<h2 id="failed-payments">Failed Payments</h2>');
    expect(html).toContain("<p>1 attendee(s) with unresolved payments</p>");
  });

  test("renders one delete row per attendee with its own columns", () => {
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain('<th class="col-quantity">Qty</th>');
    expect(html).toContain("<th>Registered</th>");
    expect(html).toContain("<td>John Doe</td>");
    expect(html).toContain('<td class="col-quantity">2</td>');
    expect(html).toContain(`<td>${formatDatetimeShort(attendee.created)}</td>`);
  });

  test("points each row's delete at that attendee's record", () => {
    expect(html).toContain(
      'action="/admin/listing/7/attendee/9/delete-incomplete"',
    );
    expect(html).toContain('class="inline"');
    expect(html).toContain('class="link-button danger"');
    expect(html).toContain("<button");
    expect(html).toContain(">Delete</button>");
  });
});

describe("AddAttendeeSection", () => {
  registerListingTemplateHooks();

  test("warns about the child listing a public booking would need", () => {
    const html = String(
      AddAttendeeSection({
        childNames: ["Kayak Hire", "Wetsuit Hire"],
        listing: testListingWithCount({ id: 7, listing_type: "daily" }),
      }),
    );
    expect(html).toContain('<h2 id="add-attendee">Add Attendee</h2>');
    expect(html).toContain(
      '<p class="notice">This listing requires a child listing (Kayak Hire, Wetsuit Hire) when booked publicly.',
    );
    expect(html).toContain('action="/admin/listing/7/attendee"');
    expect(html).toContain("<span>Add Attendee</span>");
  });

  test("warns about one child listing the same way", () => {
    const html = String(
      AddAttendeeSection({
        childNames: ["Kayak Hire"],
        listing: testListingWithCount({ listing_type: "daily" }),
      }),
    );
    expect(html).toContain(
      "requires a child listing (Kayak Hire) when booked publicly",
    );
  });

  test("shows no child warning without child listings", () => {
    const html = String(
      AddAttendeeSection({
        listing: testListingWithCount({ id: 7, listing_type: "daily" }),
      }),
    );
    expect(html).not.toContain("child listing");
    expect(html).not.toContain('class="notice"');
  });

  test("offers the day count only on a customisable daily listing", () => {
    const customisable = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 100, 2: 180 },
      duration_days: 2,
      listing_type: "daily",
    });
    expect(String(AddAttendeeSection({ listing: customisable }))).toContain(
      "Number of days",
    );
    // A daily listing without customisable days and a customisable
    // non-daily listing both stay without the day-count choice.
    expect(
      String(
        AddAttendeeSection({
          listing: testListingWithCount({ listing_type: "daily" }),
        }),
      ),
    ).not.toContain("Number of days");
    expect(
      String(
        AddAttendeeSection({
          listing: testListingWithCount({
            customisable_days: true,
            day_prices: { 1: 100, 2: 180 },
            duration_days: 2,
          }),
        }),
      ),
    ).not.toContain("Number of days");
  });
});
