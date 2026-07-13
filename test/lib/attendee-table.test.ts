import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken, signCsrfToken } from "#shared/csrf.ts";
import {
  AttendeeTable,
  type AttendeeTableOptions,
  type AttendeeTableRow,
  formatAddressInline,
  sortAttendeeRows,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import { hasInputWithValue } from "#test-utils/csrf.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testAttendee, testRadioQuestion } from "#test-utils/factories.ts";

const ALLOWED_DOMAIN = "example.com";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

const makeRow = (
  overrides: Partial<AttendeeTableRow> = {},
): AttendeeTableRow => ({
  attendee: testAttendee(),
  listings: [{ id: 1, name: "Test Listing" }],
  ...overrides,
});

/** A one-listing row whose listing is named `name` (id 1) */
const namedListingRow = (
  name: string,
  attendee = testAttendee(),
): AttendeeTableRow => makeRow({ attendee, listings: [{ id: 1, name }] });

const makeOpts = (
  overrides: Partial<AttendeeTableOptions> = {},
): AttendeeTableOptions => ({
  allowedDomain: ALLOWED_DOMAIN,
  rows: [makeRow()],
  showDate: false,
  showListing: false,
  ...overrides,
});

/** Zara (id=1, B Listing) then Alice (id=2, A Listing) — unsorted input order */
const zaraAliceRows = (): AttendeeTableRow[] => [
  namedListingRow("B Listing", testAttendee({ id: 1, name: "Zara" })),
  namedListingRow("A Listing", testAttendee({ id: 2, name: "Alice" })),
];

/** Render zaraAliceRows with default sorting and assert Alice appears before Zara */
const expectAliceSortedBeforeZara = () => {
  const html = AttendeeTable(
    makeOpts({ rows: zaraAliceRows(), showListing: true }),
  );
  expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("Zara"));
};

describe("AttendeeTable", () => {
  describe("always-visible columns", () => {
    test("renders check-in button column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("Check in");
      expect(html).toContain("/checkin");
    });

    test("renders Name column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Name</th>");
      expect(html).toContain("John Doe");
    });

    test("links Name to the edit attendee page", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ id: 7, name: "Jane" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain('<a href="/admin/attendees/7">Jane</a>');
    });

    test("renders Qty column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain('<th class="col-quantity">Qty</th>');
    });

    test("renders Ticket column with link", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Ticket</th>");
      // Assert the unescaped anchor (not just the URL substring), so the ticket
      // column's isHtml flag is exercised — an escaped cell would fail this.
      expect(html).toContain(
        `<a href="https://${ALLOWED_DOMAIN}/t/test-token-1">test-token-1</a>`,
      );
    });

    test("renders Registered column", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("<th>Registered</th>");
    });

    test("no longer renders an Actions column (moved to the edit page)", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).not.toContain("<th>Actions</th>");
      expect(html).not.toContain(">Edit<");
      expect(html).not.toContain(">Delete<");
      expect(html).not.toContain("Re-send Notification");
      expect(html).not.toContain("/refund");
    });
  });

  describe("column order", () => {
    test("renders columns in correct order, Listings directly after Name", () => {
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
      const html = AttendeeTable(
        makeOpts({ rows, showDate: true, showListing: true }),
      );
      const headers = [...html.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g)].map(
        (m) => m[1],
      );
      // The single empty header is for the Checked In / status column (first)
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
  });

  describe("Listings column", () => {
    test("hidden when showListing is false", () => {
      const html = AttendeeTable(makeOpts({ showListing: false }));
      expect(html).not.toContain("<th>Listings</th>");
      expect(html).not.toContain("listings-cell");
    });

    test("shown with linked listing name when showListing is true", () => {
      const rows = [makeRow({ listings: [{ id: 42, name: "Test Gala" }] })];
      const html = AttendeeTable(makeOpts({ rows, showListing: true }));
      expect(html).toContain("<th>Listings</th>");
      expect(html).toContain('<a href="/admin/listing/42">Test Gala</a>');
    });

    /** Render a two-listing grouped row (Spring Fair before Autumn Ball) */
    const groupedRowHtml = (): string =>
      AttendeeTable(
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

    test("links every listing of a grouped row, comma-separated, in row order", () => {
      expect(groupedRowHtml()).toContain(
        '<a href="/admin/listing/5">Spring Fair</a>, ' +
          '<a href="/admin/listing/3">Autumn Ball</a>',
      );
    });

    test("wraps the links in a truncating cell carrying the full list as its title", () => {
      expect(groupedRowHtml()).toContain(
        '<span class="listings-cell" title="Spring Fair, Autumn Ball">',
      );
    });

    test("escapes listing names in both the links and the title attribute", () => {
      const rows = [
        makeRow({ listings: [{ id: 9, name: 'A <b>"wild"</b> & odd one' }] }),
      ];
      const html = AttendeeTable(makeOpts({ rows, showListing: true }));
      expect(html).toContain(
        'title="A &lt;b&gt;&quot;wild&quot;&lt;/b&gt; &amp; odd one"',
      );
      expect(html).not.toContain("<b>");
    });
  });

  describe("Date column", () => {
    test("hidden when showDate is false", () => {
      const html = AttendeeTable(makeOpts({ showDate: false }));
      expect(html).not.toContain("<th>Date</th>");
    });

    test("shown when showDate is true", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows, showDate: true }));
      expect(html).toContain("<th>Date</th>");
    });
  });

  describe("Email column", () => {
    test("hidden when no attendees have email", () => {
      const rows = [makeRow({ attendee: testAttendee({ email: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Email</th>");
    });

    test("shown when at least one attendee has email", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ email: "" }) }),
        makeRow({ attendee: testAttendee({ email: "test@example.com" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Email</th>");
      expect(html).toContain("test@example.com");
    });
  });

  describe("Phone column", () => {
    test("hidden when no attendees have phone", () => {
      const rows = [makeRow({ attendee: testAttendee({ phone: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Phone</th>");
    });

    test("shown when at least one attendee has phone", () => {
      const rows = [makeRow({ attendee: testAttendee({ phone: "555-1234" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Phone</th>");
      expect(html).toContain("555-1234");
    });

    test("renders phone as clickable tel link", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      ];
      const html = AttendeeTable(makeOpts({ phonePrefix: "44", rows }));
      expect(html).toContain('href="tel:+447700900000"');
      expect(html).toContain(">07700 900000</a>");
    });

    test("uses phonePrefix option for tel link normalization", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ phone: "0234 567 8900" }) }),
      ];
      const html = AttendeeTable(makeOpts({ phonePrefix: "1", rows }));
      expect(html).toContain('href="tel:+12345678900"');
    });

    test("defaults to prefix 44 when phonePrefix not provided", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain('href="tel:+447700900000"');
    });

    test("renders empty cell for attendee without phone when column is shown", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ phone: "555-1234" }) }),
        makeRow({ attendee: testAttendee({ phone: "" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Phone</th>");
      // Attendee with phone gets a tel link
      expect(html).toContain('href="tel:+5551234"');
    });
  });

  describe("Address column", () => {
    test("hidden when no attendees have address", () => {
      const rows = [makeRow({ attendee: testAttendee({ address: "" }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Address</th>");
    });

    test("shown when at least one attendee has address", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ address: "123 Main St" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Address</th>");
      expect(html).toContain("123 Main St");
    });
  });

  describe("Special Instructions column", () => {
    test("hidden when no attendees have special instructions", () => {
      const rows = [
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("<th>Special Instructions</th>");
    });

    test("shown when at least one attendee has special instructions", () => {
      const rows = [
        makeRow({
          attendee: testAttendee({ special_instructions: "Vegetarian" }),
        }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Special Instructions</th>");
      expect(html).toContain("Vegetarian");
    });

    test("renders single-line instructions and empty cell when column is shown", () => {
      const rows = [
        makeRow({
          attendee: testAttendee({ special_instructions: "Line 1\nLine 2" }),
        }),
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("<th>Special Instructions</th>");
      expect(html).toContain("Line 1 Line 2");
      expect(html).not.toContain("Line 1, Line 2");
    });
  });

  describe("check-in button", () => {
    test("shows Check in for unchecked attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ checked_in: false }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Check in");
      expect(html).toContain('class="link-button checkin"');
    });

    test("shows Check out for checked-in attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ checked_in: true }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Check out");
      expect(html).toContain('class="link-button checkout"');
    });

    test("includes csrf token in form", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain(`value="${getCurrentCsrfToken()}"`);
    });

    test("form action points to the row's own listing", () => {
      const rows = [makeRow({ listings: [{ id: 42, name: "Test Listing" }] })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("/admin/listing/42/attendee/1/checkin");
    });

    test("includes activeFilter as return_filter", () => {
      const html = AttendeeTable(makeOpts({ activeFilter: "in" }));
      expect(hasInputWithValue(html, "return_filter", "in")).toBe(true);
    });
  });

  describe("per-attendee actions moved to the edit page", () => {
    test("never renders refund links, even for a payable attendee", () => {
      const rows = [
        makeRow({
          attendee: testAttendee({ payment_id: "pay_123" }),
        }),
      ];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("/refund");
      expect(html).not.toContain("/delete");
    });
  });

  describe("refunded badge", () => {
    test("shows Refunded badge for refunded attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ refunded: true }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Refunded");
    });

    test("does not show Check in button for refunded attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ refunded: true }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).not.toContain("Check in");
      expect(html).not.toContain("Check out");
    });

    test("shows Check in button for non-refunded attendee", () => {
      const rows = [makeRow({ attendee: testAttendee({ refunded: false }) })];
      const html = AttendeeTable(makeOpts({ rows }));
      expect(html).toContain("Check in");
      expect(html).not.toContain("Refunded");
    });
  });

  describe("return_url", () => {
    test("includes return_url as hidden form field in check-in form", () => {
      const html = AttendeeTable(makeOpts({ returnUrl: "/checkin/abc" }));
      expect(hasInputWithValue(html, "return_url", "/checkin/abc")).toBe(true);
    });

    test("does not include return_url when not provided", () => {
      const html = AttendeeTable(makeOpts({}));
      expect(html).not.toContain("return_url");
    });
  });

  describe("empty state", () => {
    test("shows default empty message when no rows", () => {
      const html = AttendeeTable(makeOpts({ rows: [] }));
      expect(html).toContain("No attendees yet");
    });

    test("shows custom empty message when provided", () => {
      const html = AttendeeTable(
        makeOpts({ emptyMessage: "Select a date", rows: [] }),
      );
      expect(html).toContain("Select a date");
    });

    test("empty row has correct colspan for minimal columns", () => {
      const html = AttendeeTable(
        makeOpts({ rows: [], showDate: false, showListing: false }),
      );
      expect(html).toContain('colspan="5"');
    });

    test("empty row colspan includes optional visible columns", () => {
      const html = AttendeeTable(
        makeOpts({ rows: [], showDate: true, showListing: true }),
      );
      expect(html).toContain('colspan="7"');
    });
  });

  describe("showCheckin option", () => {
    test("hides the check-in column when showCheckin is false", () => {
      const html = AttendeeTable(makeOpts({ showCheckin: false }));
      expect(html).not.toContain("Check in");
    });

    test("retains data columns when showCheckin is false", () => {
      const html = AttendeeTable(makeOpts({ showCheckin: false }));
      expect(html).toContain("John Doe");
      expect(html).toContain("test-token-1");
    });

    test("shows check-in button by default", () => {
      const html = AttendeeTable(makeOpts());
      expect(html).toContain("Check in");
    });

    test("empty row colspan drops the status column when showCheckin is false", () => {
      const html = AttendeeTable(makeOpts({ rows: [], showCheckin: false }));
      expect(html).toContain('colspan="4"');
    });

    test("a no-quantity row shows the indicator instead of a check-in button or ticket link", () => {
      const html = AttendeeTable(
        makeOpts({
          rows: [
            makeRow({
              attendee: testAttendee({
                quantity: 0,
                ticket_token: "ghost-token",
              }),
            }),
          ],
        }),
      );
      // The status column shows the "No quantity" indicator, not a check-in form.
      expect(html).toContain("No quantity");
      expect(html).not.toContain("/attendee/1/checkin");
      // The ticket column shows the indicator, not a live /t link.
      expect(html).not.toContain("/t/ghost-token");
    });

    test("a mid-payment staged row says the payment is in progress", () => {
      const html = AttendeeTable(
        makeOpts({
          rows: [
            makeRow({
              attendee: testAttendee({
                pending_checkout: 1,
                quantity: 0,
                ticket_token: "staged-token",
              }),
            }),
          ],
        }),
      );
      // Both indicator cells (status + ticket) explain the payment is in
      // flight — never the "No quantity" wording, which invites an edit.
      expect(html).toContain("Payment in progress");
      expect(html).not.toContain("No quantity");
      expect(html).not.toContain("/t/staged-token");
      expect(html).not.toContain("/attendee/1/checkin");
    });
  });

  describe("presorted option", () => {
    test("preserves row order when presorted is true", () => {
      const html = AttendeeTable(
        makeOpts({ presorted: true, rows: zaraAliceRows(), showListing: true }),
      );
      const zaraIdx = html.indexOf("Zara");
      const aliceIdx = html.indexOf("Alice");
      expect(zaraIdx).toBeLessThan(aliceIdx);
    });

    test("sorts rows by default when presorted is not set", () => {
      expectAliceSortedBeforeZara();
    });
  });
});

describe("sortAttendeeRows", () => {
  test("sorts by listing date ascending, null dates last", () => {
    const rows = [
      namedListingRow("A", testAttendee({ date: null, id: 1 })),
      namedListingRow("A", testAttendee({ date: "2026-03-01", id: 2 })),
      namedListingRow("A", testAttendee({ date: "2026-01-15", id: 3 })),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([3, 2, 1]);
  });

  test("sorts by first listing name when dates are equal", () => {
    const rows = [
      namedListingRow("Zebra", testAttendee({ date: "2026-03-01", id: 1 })),
      namedListingRow("Alpha", testAttendee({ date: "2026-03-01", id: 2 })),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 1]);
  });

  test("sorts by attendee name when date and listing name are equal", () => {
    const rows = [
      namedListingRow("Gala", testAttendee({ id: 1, name: "Zara" })),
      namedListingRow("Gala", testAttendee({ id: 2, name: "Alice" })),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 1]);
  });

  test("sorts by id when all other fields are equal", () => {
    const rows = [
      namedListingRow("Gala", testAttendee({ id: 5, name: "Sam" })),
      namedListingRow("Gala", testAttendee({ id: 2, name: "Sam" })),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 5]);
  });

  test("applies full multi-key sort order", () => {
    const rows = [
      namedListingRow(
        "Concert",
        testAttendee({ date: "2026-02-01", id: 1, name: "Bob" }),
      ),
      namedListingRow(
        "Gala",
        testAttendee({ date: null, id: 2, name: "Alice" }),
      ),
      namedListingRow(
        "Concert",
        testAttendee({ date: "2026-01-15", id: 3, name: "Alice" }),
      ),
      namedListingRow(
        "Concert",
        testAttendee({ date: "2026-02-01", id: 4, name: "Alice" }),
      ),
    ];
    const sorted = sortAttendeeRows(rows);
    // date 2026-01-15 first, then 2026-02-01 (Alice before Bob by name), then null date last
    expect(sorted.map((r) => r.attendee.id)).toEqual([3, 4, 1, 2]);
  });

  test("sorts a listing-less row before a named listing (empty name first)", () => {
    const rows = [
      namedListingRow("Gala", testAttendee({ id: 1 })),
      makeRow({ attendee: testAttendee({ id: 2 }), listings: [] }),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 1]);
  });

  test("sorts two listing-less rows by attendee name", () => {
    const rows = [
      makeRow({
        attendee: testAttendee({ id: 1, name: "Zara" }),
        listings: [],
      }),
      makeRow({
        attendee: testAttendee({ id: 2, name: "Alice" }),
        listings: [],
      }),
    ];
    const sorted = sortAttendeeRows(rows);
    expect(sorted.map((r) => r.attendee.id)).toEqual([2, 1]);
  });

  test("does not mutate the original array", () => {
    const rows = [
      namedListingRow("B", testAttendee({ id: 2 })),
      namedListingRow("A", testAttendee({ id: 1 })),
    ];
    const original = [...rows];
    sortAttendeeRows(rows);
    expect(rows.map((r) => r.attendee.id)).toEqual(
      original.map((r) => r.attendee.id),
    );
  });
});

describe("AttendeeTable sorting", () => {
  test("renders rows in sorted order", () => {
    expectAliceSortedBeforeZara();
  });
});

describe("formatAddressInline", () => {
  test("returns empty string for empty input", () => {
    expect(formatAddressInline("")).toBe("");
  });

  test("joins multi-line address with commas", () => {
    expect(formatAddressInline("123 Main St\nApt 4\nNew York")).toBe(
      "123 Main St, Apt 4, New York",
    );
  });

  test("preserves existing trailing comma", () => {
    expect(formatAddressInline("123 Main St,\nNew York")).toBe(
      "123 Main St, New York",
    );
  });

  test("trims whitespace from lines", () => {
    expect(formatAddressInline("  123 Main St  \n  New York  ")).toBe(
      "123 Main St, New York",
    );
  });

  test("filters out blank lines", () => {
    expect(formatAddressInline("123 Main St\n\nNew York")).toBe(
      "123 Main St, New York",
    );
  });
});

describe("AttendeeTable with questionData", () => {
  const questionData: TableQuestionData = {
    attendeeAnswerMap: new Map([
      [1, [10, 20]],
      [2, [11]],
    ]),
    questions: [
      testRadioQuestion(1, "Size?", [
        [10, "Small"],
        [11, "Large"],
      ]),
      testRadioQuestion(2, "Color?", [
        [20, "Red"],
        [21, "Blue"],
      ]),
    ],
  };

  test("renders Answers column header when questionData is provided", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData,
        rows: [makeRow({ attendee: testAttendee({ id: 1 }) })],
      }),
    );
    expect(html).toContain("<th>Answers</th>");
  });

  test("renders answer text in cell with smaller font", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData,
        rows: [makeRow({ attendee: testAttendee({ id: 1 }) })],
      }),
    );
    expect(html).toContain('class="answers-cell"');
    expect(html).toContain("Small, Red");
  });

  test("renders tooltip with question: answer format", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData,
        rows: [makeRow({ attendee: testAttendee({ id: 1 }) })],
      }),
    );
    expect(html).toContain('title="Size?: Small, Color?: Red"');
  });

  test("renders empty answer for attendee with no answers", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData,
        rows: [makeRow({ attendee: testAttendee({ id: 999 }) })],
      }),
    );
    expect(html).toContain('class="answers-cell"');
    expect(html).toContain('title=""');
  });

  test("renders partial answers for attendee with some answers", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData,
        rows: [makeRow({ attendee: testAttendee({ id: 2 }) })],
      }),
    );
    expect(html).toContain("Large");
    expect(html).not.toContain("Small");
  });

  test("does not render Answers column when questionData is undefined", () => {
    const html = AttendeeTable(makeOpts());
    expect(html).not.toContain("<th>Answers</th>");
    expect(html).not.toContain("answers-cell");
  });

  test("does not render Answers column when questions are empty", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData: { attendeeAnswerMap: new Map(), questions: [] },
      }),
    );
    expect(html).not.toContain("<th>Answers</th>");
  });

  test("includes Answers column in colspan for empty table", () => {
    const html = AttendeeTable(
      makeOpts({
        questionData,
        rows: [],
      }),
    );
    expect(html).toContain("<th>Answers</th>");
    expect(html).toContain("No attendees yet");
  });
});

describe("AttendeeTable columnTemplate", () => {
  test("renders only specified columns in template order", () => {
    const html = AttendeeTable(
      makeOpts({
        columnTemplate: "{{name}}, {{qty}}, {{registered}}",
        showCheckin: false,
      }),
    );
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g)].map(
      (m) => m[1],
    );
    expect(headers).toEqual(["Name", "Qty", "Registered"]);
  });

  test("falls back to default order for invalid template", () => {
    const html = AttendeeTable(
      makeOpts({
        columnTemplate: "{{invalid_column}}",
      }),
    );
    // Should still render the default columns
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain('<th class="col-quantity">Qty</th>');
  });

  test("hides data-dependent column when no rows have data", () => {
    const rows = [makeRow({ attendee: testAttendee({ email: "" }) })];
    const html = AttendeeTable(
      makeOpts({
        columnTemplate: "{{name}}, {{email}}, {{qty}}",
        rows,
        showCheckin: false,
      }),
    );
    expect(html).not.toContain("<th>Email</th>");
  });

  test("reorders columns as specified by template", () => {
    const rows = [
      makeRow({
        attendee: testAttendee({ email: "a@b.com" }),
      }),
    ];
    const html = AttendeeTable(
      makeOpts({
        columnTemplate: "{{qty}}, {{name}}, {{email}}",
        rows,
        showCheckin: false,
      }),
    );
    const headers = [...html.matchAll(/<th(?:\s[^>]*)?>([^<]*)<\/th>/g)].map(
      (m) => m[1],
    );
    expect(headers).toEqual(["Qty", "Name", "Email"]);
  });

  test("applies date filter to registered column", () => {
    const rows = [
      makeRow({
        attendee: testAttendee({ created: "2026-04-10T14:00:00Z" }),
      }),
    ];
    const html = AttendeeTable(
      makeOpts({
        columnTemplate: '{{name}}, {{registered | date: "%B %d, %Y"}}',
        rows,
        showCheckin: false,
      }),
    );
    expect(html).toContain("April 10, 2026");
  });

  test("renders default cell format when no filter applied", () => {
    const rows = [
      makeRow({
        attendee: testAttendee({ created: "2026-04-10T14:00:00Z" }),
      }),
    ];
    const html = AttendeeTable(
      makeOpts({
        columnTemplate: "{{name}}, {{registered}}",
        rows,
        showCheckin: false,
      }),
    );
    // Default uses formatDatetimeShort (e.g. "10/04/2026 14:00"), not Liquid strftime
    expect(html).toContain("2026");
    expect(html).not.toContain("April 10, 2026");
  });
});
