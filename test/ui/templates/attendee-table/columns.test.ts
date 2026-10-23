import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { testAttendee } from "#test-utils/factories.ts";
import {
  ALLOWED_DOMAIN,
  attendeeTableSuite,
  makeOpts,
  makeRow,
  namedListingRow,
  render,
} from "./shared.ts";

attendeeTableSuite(() => {
  describe("always-visible columns", () => {
    test("renders check-in button column", () => {
      const html = render(makeOpts());
      assertStringIncludes(html, "Check in");
      assertStringIncludes(html, "/checkin");
    });

    test("renders Name column", () => {
      const html = render(makeOpts());
      assertStringIncludes(html, "<th>Name</th>");
      assertStringIncludes(html, "John Doe");
    });

    test("links Name to the edit attendee page", () => {
      const html = render(
        makeOpts({
          rows: [makeRow({ attendee: testAttendee({ id: 7, name: "Jane" }) })],
        }),
      );
      assertStringIncludes(html, '<a href="/admin/attendees/7">Jane</a>');
    });

    test("shows owed-send badges only where admin links show", () => {
      const flagged = testAttendee({
        email_owed: 1,
        email_pending: 1,
        webhooks_pending: 1,
      });
      const staff = render(
        makeOpts({ rows: [makeRow({ attendee: flagged })] }),
      );
      assertStringIncludes(staff, "Email not sent");
      assertStringIncludes(staff, "Webhooks not sent");
      const scanner = render(
        makeOpts({
          adminLinks: false,
          rows: [makeRow({ attendee: flagged })],
        }),
      );
      assert(!scanner.includes("Email not sent"));
      assert(!scanner.includes("Webhooks not sent"));
    });

    test("renders Qty column", () => {
      assertStringIncludes(
        render(makeOpts()),
        '<th class="col-quantity">Qty</th>',
      );
    });

    test("renders Ticket column with link", () => {
      const html = render(makeOpts());
      assertStringIncludes(html, "<th>Ticket</th>");
      assertStringIncludes(
        html,
        `<a href="https://${ALLOWED_DOMAIN}/t/test-token-1">test-token-1</a>`,
      );
    });

    test("renders Registered column", () => {
      assertStringIncludes(render(makeOpts()), "<th>Registered</th>");
    });

    test("does not render the moved Actions column", () => {
      const html = render(makeOpts());
      assert(!html.includes("<th>Actions</th>"));
      assert(!html.includes(">Edit<"));
      assert(!html.includes(">Delete<"));
      assert(!html.includes("Re-send Notification"));
      assert(!html.includes("/refund"));
    });
  });

  test("renders columns in the configured default order", () => {
    const rows = [
      namedListingRow(
        "Gala",
        testAttendee({
          address: "123 Main",
          email: "a@b.com",
          phone: "555",
          special_instructions: "VIP",
        }),
      ),
    ];
    const html = render(makeOpts({ rows, showDate: true, showListing: true }));
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g)].map(
      (match) => match[1],
    );
    expect(headers).toEqual([
      "",
      "Date",
      "Name",
      "Listings",
      "Email",
      "Phone",
      "Address",
      "Special instructions",
      "Qty",
      "Ticket",
      "Registered",
    ]);
  });

  describe("Listings column", () => {
    test("is hidden when showListing is false", () => {
      const html = render(makeOpts({ showListing: false }));
      assert(!html.includes("<th>Listings</th>"));
      assert(!html.includes("listings-cell"));
    });

    test("links the listing when showListing is true", () => {
      const html = render(
        makeOpts({
          rows: [makeRow({ listings: [{ id: 42, name: "Test Gala" }] })],
          showListing: true,
        }),
      );
      assertStringIncludes(html, "<th>Listings</th>");
      assertStringIncludes(html, '<a href="/admin/listing/42">Test Gala</a>');
    });

    const groupedRowHtml = (): string =>
      render(
        makeOpts({
          rows: [
            makeRow({
              listings: [
                { id: 5, name: "Spring Fair" },
                { id: 3, name: "Autumn Ball" },
              ],
            }),
          ],
          showListing: true,
        }),
      );

    test("links grouped listings in row order", () => {
      assertStringIncludes(
        groupedRowHtml(),
        '<a href="/admin/listing/5">Spring Fair</a>, ' +
          '<a href="/admin/listing/3">Autumn Ball</a>',
      );
    });

    test("puts the complete grouped listing names in the title", () => {
      assertStringIncludes(
        groupedRowHtml(),
        '<span class="listings-cell" title="Spring Fair, Autumn Ball">',
      );
    });

    test("escapes listing names in links and titles", () => {
      const html = render(
        makeOpts({
          rows: [
            makeRow({
              listings: [{ id: 9, name: 'A <b>"wild"</b> & odd one' }],
            }),
          ],
          showListing: true,
        }),
      );
      assertStringIncludes(
        html,
        'title="A &lt;b&gt;&quot;wild&quot;&lt;/b&gt; &amp; odd one"',
      );
      assert(!html.includes("<b>"));
    });
  });

  describe("optional columns", () => {
    const fieldCases = [
      ["Email", "email", "test@example.com"],
      ["Phone", "phone", "555-1234"],
      ["Address", "address", "123 Main St"],
      ["Special instructions", "special_instructions", "Vegetarian"],
    ] as const;

    for (const [heading, field, value] of fieldCases) {
      test(`hides ${heading} when every value is blank`, () => {
        const attendee = testAttendee({ [field]: "" });
        assert(
          !render(makeOpts({ rows: [makeRow({ attendee })] })).includes(
            `<th>${heading}</th>`,
          ),
        );
      });

      test(`shows ${heading} when a value is present`, () => {
        const attendee = testAttendee({ [field]: value });
        const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
        assertStringIncludes(html, `<th>${heading}</th>`);
        assertStringIncludes(html, value);
      });
    }

    test("hides Date when showDate is false", () => {
      assert(!render(makeOpts({ showDate: false })).includes("<th>Date</th>"));
    });

    test("shows Date when showDate is true", () => {
      assertStringIncludes(
        render(makeOpts({ showDate: true })),
        "<th>Date</th>",
      );
    });

    test("renders phone as a normalized tel link", () => {
      const attendee = testAttendee({ phone: "07700 900000" });
      const html = render(
        makeOpts({ phonePrefix: "44", rows: [makeRow({ attendee })] }),
      );
      assertStringIncludes(html, 'href="tel:+447700900000"');
      assertStringIncludes(html, ">07700 900000</a>");
    });

    test("uses the supplied phone prefix", () => {
      const attendee = testAttendee({ phone: "0234 567 8900" });
      const html = render(
        makeOpts({ phonePrefix: "1", rows: [makeRow({ attendee })] }),
      );
      assertStringIncludes(html, 'href="tel:+12345678900"');
    });

    test("defaults the phone prefix to 44", () => {
      const attendee = testAttendee({ phone: "07700 900000" });
      assertStringIncludes(
        render(makeOpts({ rows: [makeRow({ attendee })] })),
        'href="tel:+447700900000"',
      );
    });

    // A roster where one person filled the field in and another did not: the
    // column shows for everyone, so the blank row must render an empty cell.
    const mixedRows = (field: "address" | "special_instructions") => [
      makeRow({ attendee: testAttendee({ id: 1, [field]: "Filled in" }) }),
      makeRow({ attendee: testAttendee({ id: 2, [field]: "" }) }),
    ];

    for (const [heading, field] of [
      ["Address", "address"],
      ["Special instructions", "special_instructions"],
    ] as const) {
      test(`renders a blank ${heading} cell beside a filled one`, () => {
        const html = render(makeOpts({ rows: mixedRows(field) }));
        assertStringIncludes(html, `<th>${heading}</th>`);
        assertStringIncludes(html, "Filled in");
        assertStringIncludes(html, "<td></td>");
      });
    }

    test("renders special instructions on one line", () => {
      const attendee = testAttendee({
        special_instructions: "Line 1\nLine 2",
      });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      assertStringIncludes(html, "Line 1 Line 2");
      assert(!html.includes("Line 1, Line 2"));
    });
  });
});
