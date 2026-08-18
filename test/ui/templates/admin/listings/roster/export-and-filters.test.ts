import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  detailHtml,
  registerListingTemplateHooks,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";

describe("adminListingPage export button", () => {
  registerListingTemplateHooks();

  test("renders export CSV button", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }));
    expect(html).toContain("/admin/listing/1/export");
    expect(html).toContain("Export CSV");
  });

  test("the export link carries the active check-in filter", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 1 }), {
      activeFilter: "in",
      attendees: [testAttendee({ checked_in: true })],
    });
    expect(html).toContain("/admin/listing/1/export?filter=in");
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
    testAttendee({ checked_in: true, id: 1, name: "Checked In User" }),
    testAttendee({ checked_in: false, id: 2, name: "Not Checked In User" }),
  ];

  test("renders All / Checked In / Checked Out links", () => {
    const html = linkHtml();
    expect(html).toContain("All");
    expect(html).toContain("Checked In");
    expect(html).toContain("Checked Out");
  });

  test("bolds All when no filter is active", () => {
    const html = linkHtml();
    expect(html).toContain("<strong><u>All</u></strong>");
    expect(html).toContain(
      `href="/admin/listing/${listing.id}/attendees?filter=in"`,
    );
    expect(html).toContain(
      `href="/admin/listing/${listing.id}/attendees?filter=out"`,
    );
  });

  test("bolds Checked In when filter is in", () => {
    const html = linkHtml("in");
    expect(html).toContain("<strong><u>Checked In</u></strong>");
    expect(html).toContain(`href="/admin/listing/${listing.id}/attendees"`);
  });

  test("bolds Checked Out when filter is out", () => {
    const html = linkHtml("out");
    expect(html).toContain("<strong><u>Checked Out</u></strong>");
  });

  test("filters to only checked-in attendees when filter is in", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }), {
      activeFilter: "in",
      attendees: namedPair(),
    });
    expect(html).toContain("Checked In User");
    expect(html).not.toContain("Not Checked In User");
  });

  test("filters to only checked-out attendees when filter is out", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }), {
      activeFilter: "out",
      attendees: [
        testAttendee({ checked_in: true, id: 1, name: "Alice InPerson" }),
        testAttendee({ checked_in: false, id: 2, name: "Bob Remote" }),
      ],
    });
    expect(html).not.toContain("Alice InPerson");
    expect(html).toContain("Bob Remote");
  });

  test("shows all attendees when filter is all", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 2 }), {
      activeFilter: "all",
      attendees: namedPair(),
    });
    expect(html).toContain("Checked In User");
    expect(html).toContain("Not Checked In User");
  });

  test("includes return_filter hidden field in checkin form", () => {
    const html = detailHtml(testListingWithCount({ attendee_count: 1 }), {
      activeFilter: "in",
      attendees: [testAttendee({ checked_in: true })],
    });
    expect(html).toContain('name="return_filter"');
    expect(html).toContain('value="in"');
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
    expect(html).toContain("Failed Payments");
    expect(html).toContain("1 attendee(s) with unresolved payments");
    expect(html).toContain("/delete-incomplete");
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
    expect(html).not.toContain("Failed Payments");
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
    expect(html).not.toContain("Failed Payments");
    expect(html).toContain("John Doe");
  });

  test("hides Failed Payments section for free listings", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 1, unit_price: 0 }),
      { attendees: [testAttendee({ id: 1, price_paid: "0" })] },
    );
    expect(html).not.toContain("Failed Payments");
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
    expect(html).toContain("2 / 100");
  });

  test("excludes incomplete attendees from checked-in count", () => {
    const html = detailHtml(
      testListingWithCount({ attendee_count: 2, unit_price: 1000 }),
      {
        attendees: [
          testAttendee({
            checked_in: true,
            id: 1,
            payment_id: "pi_ok",
            price_paid: "1000",
          }),
          testAttendee({
            checked_in: true,
            id: 2,
            payment_id: "",
            price_paid: "1000",
          }),
        ],
      },
    );
    // Only complete attendees count: 1 checked in / 1 total
    expect(html).toContain("1 / 1");
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
    expect(html).toContain("£10");
    expect(html).not.toContain("£30");
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
    expect(failedSection).toContain("Jane Stuck");
    expect(failedSection).toContain("Delete");
    expect(failedSection).toContain("/delete-incomplete");
    expect(failedSection).not.toContain("Check in");
    expect(failedSection).not.toContain("Check out");
    expect(failedSection).not.toContain("Refund");
    expect(failedSection).not.toContain("Re-send Webhook");
  });
});

describe("adminListingPage Renewal tag", () => {
  registerListingTemplateHooks();

  test("renders Renewal tag for tier listings with months_per_unit > 0", () => {
    const html = detailHtml(testListingWithCount({ months_per_unit: 3 }), {
      allowedDomain: "",
    });
    expect(html).toContain("Renewal");
  });

  test("does not render Renewal tag for listings with months_per_unit = 0", () => {
    const html = detailHtml(testListingWithCount({ months_per_unit: 0 }), {
      allowedDomain: "",
    });
    expect(html).not.toContain("Renewal");
  });
});
