/** Rendering of the listing roster's sections: the attendee list with its
 * email action, the failed-payments table, and the add-attendee form. */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { rosterListSetup } from "#routes/admin/listings-view.ts";
import { formatDatetimeShort } from "#shared/dates.ts";
import {
  AddAttendeeSection,
  AttendeesSection,
  FailedPaymentsSection,
  filterAttendees,
} from "#templates/admin/listings/attendees.tsx";
import type { RosterListView } from "#templates/admin/listings/types.ts";
import { registerListingTemplateHooks } from "#test/ui/templates/admin/listings/helpers.ts";
import { bookedLineRow } from "#test-utils/attendees/pair-bookings.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

describe("filterAttendees", () => {
  registerListingTemplateHooks();

  const rows = [
    testAttendee({ checked_in: 1, id: 1 }),
    testAttendee({ checked_in: 0, id: 2 }),
    testAttendee({ checked_in: 0, id: 3, quantity: 0 }),
    testAttendee({ checked_in: 1, id: 4, quantity: 0 }),
    // A part booking: one of two admitted. It still owes a ticket, so the
    // door finds it under "out", not "in".
    testAttendee({ checked_in: 1, id: 5, quantity: 2 }),
  ];
  const ids = (filtered: ReturnType<typeof filterAttendees>) =>
    filtered.map((a) => a.id);

  test("all keeps every row, quantity or not", () => {
    expect(ids(filterAttendees(rows, "all"))).toEqual([1, 2, 3, 4, 5]);
  });

  test("in keeps only fully checked-in tickets", () => {
    expect(ids(filterAttendees(rows, "in"))).toEqual([1]);
  });

  test("out keeps tickets that still owe, including part bookings", () => {
    expect(ids(filterAttendees(rows, "out"))).toEqual([2, 5]);
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
      groupId: null,
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
        tableRows: [bookedLineRow(testAttendee(), listing)],
      }),
    );

  test("heads the section and omits the listing column it cannot need", () => {
    const html = sectionHtml(undefined);
    says(html, '<h2 id="attendees">Attendees</h2>');
    // The page is already one listing's roster, so no Listings column.
    assert(!html.includes("<th>Listings</th>"));
  });

  test("renders the email action only when the compose page would open", () => {
    assert(!sectionHtml(undefined).includes("Email this date's attendees"));
    says(
      sectionHtml("/admin/emails?mock"),
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
    says(html, '<h2 id="failed-payments">Failed Payments</h2>');
    says(html, "<p>1 attendee(s) with unresolved payments</p>");
  });

  test("renders one delete row per attendee with its own columns", () => {
    says(html, "<th>Name</th>");
    says(html, '<th class="col-quantity">Qty</th>');
    says(html, "<th>Registered</th>");
    says(html, "<td>John Doe</td>");
    says(html, '<td class="col-quantity">2</td>');
    says(html, `<td>${formatDatetimeShort(attendee.created)}</td>`);
  });

  test("points each row's delete at that attendee's record", () => {
    says(html, 'action="/admin/listing/7/attendee/9/delete-incomplete"');
    says(html, 'class="inline"');
    says(html, 'class="link-button danger"');
    says(html, "<button");
    says(html, ">Delete</button>");
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
    says(html, '<h2 id="add-attendee">Add Attendee</h2>');
    says(
      html,
      '<p class="notice">This listing requires a child listing (Kayak Hire, Wetsuit Hire) when booked publicly.',
    );
    says(html, 'action="/admin/listing/7/attendee"');
    says(html, "<span>Add Attendee</span>");
  });

  test("warns about one child listing the same way", () => {
    const html = String(
      AddAttendeeSection({
        childNames: ["Kayak Hire"],
        listing: testListingWithCount({ listing_type: "daily" }),
      }),
    );
    says(html, "requires a child listing (Kayak Hire) when booked publicly");
  });

  test("shows no child warning without child listings", () => {
    const html = String(
      AddAttendeeSection({
        listing: testListingWithCount({ id: 7, listing_type: "daily" }),
      }),
    );
    assert(!html.includes("child listing"));
    assert(!html.includes('class="notice"'));
  });

  test("offers the day count only on a customisable daily listing", () => {
    const customisable = testListingWithCount({
      customisable_days: true,
      day_prices: { 1: 100, 2: 180 },
      duration_days: 2,
      listing_type: "daily",
    });
    says(
      String(AddAttendeeSection({ listing: customisable })),
      "Number of days",
    );
    // A daily listing without customisable days and a customisable
    // non-daily listing both stay without the day-count choice.
    assert(
      !String(
        AddAttendeeSection({
          listing: testListingWithCount({ listing_type: "daily" }),
        }),
      ).includes("Number of days"),
    );
    assert(
      !String(
        AddAttendeeSection({
          listing: testListingWithCount({
            customisable_days: true,
            day_prices: { 1: 100, 2: 180 },
            duration_days: 2,
          }),
        }),
      ).includes("Number of days"),
    );
  });
});
