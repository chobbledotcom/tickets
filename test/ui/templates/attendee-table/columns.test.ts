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
      expect(html).toContain("Check in");
      expect(html).toContain("/checkin");
    });

    test("renders Name column", () => {
      const html = render(makeOpts());
      expect(html).toContain("<th>Name</th>");
      expect(html).toContain("John Doe");
    });

    test("links Name to the edit attendee page", () => {
      const html = render(
        makeOpts({
          rows: [makeRow({ attendee: testAttendee({ id: 7, name: "Jane" }) })],
        }),
      );
      expect(html).toContain('<a href="/admin/attendees/7">Jane</a>');
    });

    test("renders Qty column", () => {
      expect(render(makeOpts())).toContain('<th class="col-quantity">Qty</th>');
    });

    test("renders Ticket column with link", () => {
      const html = render(makeOpts());
      expect(html).toContain("<th>Ticket</th>");
      expect(html).toContain(
        `<a href="https://${ALLOWED_DOMAIN}/t/test-token-1">test-token-1</a>`,
      );
    });

    test("renders Registered column", () => {
      expect(render(makeOpts())).toContain("<th>Registered</th>");
    });

    test("does not render the moved Actions column", () => {
      const html = render(makeOpts());
      expect(html).not.toContain("<th>Actions</th>");
      expect(html).not.toContain(">Edit<");
      expect(html).not.toContain(">Delete<");
      expect(html).not.toContain("Re-send Notification");
      expect(html).not.toContain("/refund");
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
      "Special Instructions",
      "Qty",
      "Ticket",
      "Registered",
    ]);
  });

  describe("Listings column", () => {
    test("is hidden when showListing is false", () => {
      const html = render(makeOpts({ showListing: false }));
      expect(html).not.toContain("<th>Listings</th>");
      expect(html).not.toContain("listings-cell");
    });

    test("links the listing when showListing is true", () => {
      const html = render(
        makeOpts({
          rows: [makeRow({ listings: [{ id: 42, name: "Test Gala" }] })],
          showListing: true,
        }),
      );
      expect(html).toContain("<th>Listings</th>");
      expect(html).toContain('<a href="/admin/listing/42">Test Gala</a>');
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
      expect(groupedRowHtml()).toContain(
        '<a href="/admin/listing/5">Spring Fair</a>, ' +
          '<a href="/admin/listing/3">Autumn Ball</a>',
      );
    });

    test("puts the complete grouped listing names in the title", () => {
      expect(groupedRowHtml()).toContain(
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
      expect(html).toContain(
        'title="A &lt;b&gt;&quot;wild&quot;&lt;/b&gt; &amp; odd one"',
      );
      expect(html).not.toContain("<b>");
    });
  });

  describe("optional columns", () => {
    const fieldCases = [
      ["Email", "email", "test@example.com"],
      ["Phone", "phone", "555-1234"],
      ["Address", "address", "123 Main St"],
      ["Special Instructions", "special_instructions", "Vegetarian"],
    ] as const;

    for (const [heading, field, value] of fieldCases) {
      test(`hides ${heading} when every value is blank`, () => {
        const attendee = testAttendee({ [field]: "" });
        expect(
          render(makeOpts({ rows: [makeRow({ attendee })] })),
        ).not.toContain(`<th>${heading}</th>`);
      });

      test(`shows ${heading} when a value is present`, () => {
        const attendee = testAttendee({ [field]: value });
        const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
        expect(html).toContain(`<th>${heading}</th>`);
        expect(html).toContain(value);
      });
    }

    test("hides Date when showDate is false", () => {
      expect(render(makeOpts({ showDate: false }))).not.toContain(
        "<th>Date</th>",
      );
    });

    test("shows Date when showDate is true", () => {
      expect(render(makeOpts({ showDate: true }))).toContain("<th>Date</th>");
    });

    test("renders phone as a normalized tel link", () => {
      const attendee = testAttendee({ phone: "07700 900000" });
      const html = render(
        makeOpts({ phonePrefix: "44", rows: [makeRow({ attendee })] }),
      );
      expect(html).toContain('href="tel:+447700900000"');
      expect(html).toContain(">07700 900000</a>");
    });

    test("uses the supplied phone prefix", () => {
      const attendee = testAttendee({ phone: "0234 567 8900" });
      const html = render(
        makeOpts({ phonePrefix: "1", rows: [makeRow({ attendee })] }),
      );
      expect(html).toContain('href="tel:+12345678900"');
    });

    test("defaults the phone prefix to 44", () => {
      const attendee = testAttendee({ phone: "07700 900000" });
      expect(render(makeOpts({ rows: [makeRow({ attendee })] }))).toContain(
        'href="tel:+447700900000"',
      );
    });

    test("renders special instructions on one line", () => {
      const attendee = testAttendee({
        special_instructions: "Line 1\nLine 2",
      });
      const html = render(makeOpts({ rows: [makeRow({ attendee })] }));
      expect(html).toContain("Line 1 Line 2");
      expect(html).not.toContain("Line 1, Line 2");
    });
  });
});
