import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  detailHtml,
  registerListingTemplateHooks,
  renderRosterPanel,
  type renderRosterPanel as renderRosterPanelType,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

describe("adminListingPage export button", () => {
  registerListingTemplateHooks();

  test("renders export CSV button", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }));
    says(html, "/admin/listing/1/export");
    says(html, "Export CSV");
  });

  test("the export link carries the active check-in filter", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 1 }), {
      activeFilter: "in",
      attendees: [testAttendee({ checked_in: 1 })],
    });
    says(html, "/admin/listing/1/export?filter=in");
  });
});

describe("adminListingPage filter links", () => {
  registerListingTemplateHooks();

  const listing = testListingWithCount({ attendee_count: 1 });
  const oneAttendee = [testAttendee()];
  const linkHtml = (activeFilter?: "in" | "out") =>
    detailHtml(
      listing,
      activeFilter
        ? { activeFilter, attendees: oneAttendee }
        : { attendees: oneAttendee },
    );
  // The two named attendees shared by the checked-in / show-all filter tests.
  const namedPair = () => [
    testAttendee({ checked_in: 1, id: 1, name: "Checked In User" }),
    testAttendee({ checked_in: 0, id: 2, name: "Not Checked In User" }),
  ];

  test("renders All / Checked In / Checked Out links", () => {
    const html = linkHtml();
    says(html, "All");
    says(html, "Checked In");
    says(html, "Checked Out");
  });

  test("bolds All when no filter is active", () => {
    const html = linkHtml();
    says(html, "<strong><u>All</u></strong>");
    says(html, `href="/admin/listing/${listing.id}/attendees?filter=in"`);
    says(html, `href="/admin/listing/${listing.id}/attendees?filter=out"`);
  });

  test("bolds Checked In when filter is in", () => {
    const html = linkHtml("in");
    says(html, "<strong><u>Checked In</u></strong>");
    says(html, `href="/admin/listing/${listing.id}/attendees"`);
  });

  test("bolds Checked Out when filter is out", () => {
    const html = linkHtml("out");
    says(html, "<strong><u>Checked Out</u></strong>");
  });

  test("filters to only checked-in attendees when filter is in", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }), {
      activeFilter: "in",
      attendees: namedPair(),
    });
    says(html, "Checked In User");
    assert(!html.includes("Not Checked In User"));
  });

  test("filters to only checked-out attendees when filter is out", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }), {
      activeFilter: "out",
      attendees: [
        testAttendee({ checked_in: 1, id: 1, name: "Alice InPerson" }),
        testAttendee({ checked_in: 0, id: 2, name: "Bob Remote" }),
      ],
    });
    assert(!html.includes("Alice InPerson"));
    says(html, "Bob Remote");
  });

  test("shows all attendees when filter is all", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }), {
      activeFilter: "all",
      attendees: namedPair(),
    });
    says(html, "Checked In User");
    says(html, "Not Checked In User");
  });

  test("includes return_filter hidden field in checkin form", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 1 }), {
      activeFilter: "in",
      attendees: [testAttendee({ checked_in: 1 })],
    });
    says(html, 'name="return_filter"');
    says(html, 'value="in"');
  });
});

describe("adminListingPage add attendee", () => {
  registerListingTemplateHooks();

  test("offers the add-attendee form beneath the roster", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 0 }));
    says(html, 'id="add-attendee"');
  });
});

describe("adminListingPage failed payments", () => {
  registerListingTemplateHooks();

  // One resolved payment plus one unresolved (empty payment_id) attendee — the
  // mix several failed-payment tests build on.
  const paidPlusFailed = () => [
    testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
    testAttendee({ id: 2, payment_id: "", price_paid: "1000" }),
  ];

  test("shows Failed Payments section when incomplete attendees exist", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 3, unit_price: 1000 }),
      { attendees: paidPlusFailed() },
    );
    says(html, "Failed Payments");
    says(html, "1 attendee(s) with unresolved payments");
    says(html, "/delete-incomplete");
  });

  test("hides Failed Payments section when no incomplete attendees", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 1, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
        ],
      },
    );
    assert(!html.includes("Failed Payments"));
  });

  test("hides Failed Payments section when an empty-payment-id attendee has a processed reference", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 1, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({ id: 7, payment_id: "", price_paid: "1000" }),
        ],
        paymentReferenceAttendeeIds: new Set([7]),
      },
    );
    assert(!html.includes("Failed Payments"));
    says(html, "John Doe");
  });

  test("hides Failed Payments section for free listings", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 1, unit_price: 0 }),
      { attendees: [testAttendee({ id: 1, price_paid: "0" })] },
    );
    assert(!html.includes("Failed Payments"));
  });

  test("excludes incomplete attendees from attendee count", () => {
    const html = detailHtml(
      testListingWithCount({
        attendee_count: 3,
        max_attendees: 100,
        unit_price: 1000,
      }),
      { attendees: paidPlusFailed() },
    );
    // adjusted count: 3 - 1 (incomplete qty) = 2
    says(html, "2 / 100");
  });

  test("excludes incomplete attendees from checked-in count", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 2, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({
            checked_in: 1,
            id: 1,
            payment_id: "pi_ok",
            price_paid: "1000",
          }),
          testAttendee({
            checked_in: 1,
            id: 2,
            payment_id: "",
            price_paid: "1000",
          }),
        ],
      },
    );
    // Only complete attendees count: 1 checked in / 1 total
    says(html, "1 / 1");
  });

  test("excludes incomplete attendees from revenue", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 2, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
          testAttendee({ id: 2, payment_id: "", price_paid: "2000" }),
        ],
      },
    );
    says(html, "£10");
    assert(!html.includes("£30"));
  });

  test("failed payments table has delete button but no check-in or refund", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 1, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({
            id: 1,
            name: "Jane Stuck",
            payment_id: "",
            price_paid: "1000",
          }),
        ],
      },
    );
    const failedSection =
      html.split("Failed Payments")[1]?.split("Add Attendee")[0] ?? "";
    says(failedSection, "Jane Stuck");
    says(failedSection, "Delete");
    says(failedSection, "/delete-incomplete");
    assert(!failedSection.includes("Check in"));
    assert(!failedSection.includes("Check out"));
    assert(!failedSection.includes("Refund"));
    assert(!failedSection.includes("Re-send Webhook"));
  });
});

describe("adminListingPage Renewal tag", () => {
  registerListingTemplateHooks();

  test("renders Renewal tag for tier listings with months_per_unit > 0", () => {
    const html = detailHtml(testListingWithCount({ months_per_unit: 3 }), {
      allowedDomain: "",
    });
    says(html, "Renewal");
  });

  test("does not render Renewal tag for listings with months_per_unit = 0", () => {
    const html = detailHtml(testListingWithCount({ months_per_unit: 0 }), {
      allowedDomain: "",
    });
    assert(!html.includes("Renewal"));
  });
});

describe("adminListingPage daily roster detail table", () => {
  registerListingTemplateHooks();

  // The roster renders its shared detail rows (including the revenue row) only
  // when a daily listing is narrowed to one date. Render the roster panel alone
  // so the overview's identical revenue row cannot satisfy the assertions.
  const dailyRosterHtml = (
    unit_price: number,
    attendees: Parameters<typeof renderRosterPanelType>[0]["attendees"],
  ) =>
    renderRosterPanel({
      allowedDomain: "localhost",
      attendees,
      dateFilter: "2026-03-15",
      listing: testListingWithCount({
        attendee_count: attendees.length,
        listing_type: "daily",
        unit_price,
      }),
    });

  test("shows the revenue row for a paid listing", () => {
    const html = dailyRosterHtml(1000, [
      testAttendee({ id: 1, payment_id: "pi_ok", price_paid: "1000" }),
    ]);
    says(html, "Total Revenue");
    says(html, "£10");
  });

  test("hides the revenue row for a free listing", () => {
    const html = dailyRosterHtml(0, [testAttendee({ price_paid: "0" })]);
    assert(!html.includes("Total Revenue"));
  });
});
