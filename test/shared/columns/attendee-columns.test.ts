import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type AttendeeColumn, COLUMN_LAYOUTS } from "#shared/column-layout.ts";
import {
  ATTENDEE_TABLE_COLUMNS,
  formatAddressInline,
} from "#shared/columns/attendee-columns.ts";
import { colClass } from "#templates/components/table-columns.ts";
import {
  makeAttendeeRow as makeRow,
  attendeeColumnOpts as opts,
} from "#test/lib/column-order/attendee-column-fixtures.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { testAttendee } from "#test-utils/factories.ts";

setupTestEncryptionKey();

type ColumnMetadata = {
  label: string;
  description: string;
  isHtml?: boolean;
  className?: string;
  headerClassName?: string;
  headerText?: string;
};

const METADATA: Record<string, ColumnMetadata> = {
  address: {
    description: "Attendee postal address (inline format)",
    label: "Address",
  },
  answers: {
    className: "answers-cell",
    description: "Custom question answers",
    isHtml: true,
    label: "Answers",
  },
  date: { description: "Booking date for daily listings", label: "Date" },
  email: { description: "Attendee email address", label: "Email" },
  listings: {
    description:
      "The row's listings in display order, each linked to its detail page",
    isHtml: true,
    label: "Listings",
  },
  name: {
    description: "Attendee name with link to the edit attendee page",
    isHtml: true,
    label: "Name",
  },
  phone: {
    description: "Attendee phone number (clickable link)",
    isHtml: true,
    label: "Phone",
  },
  qty: {
    className: colClass("quantity"),
    description: "Number of tickets in this booking",
    headerClassName: colClass("quantity"),
    label: "Qty",
  },
  registered: {
    description: "Date and time the attendee registered",
    label: "Registered",
  },
  special_instructions: {
    description: "Any special instructions from the attendee",
    label: "Special Instructions",
  },
  status: {
    className: "actions-col",
    description: "Check-in/check-out button or refunded badge",
    headerClassName: "actions-col",
    headerText: "",
    isHtml: true,
    label: "Status",
  },
  ticket: {
    description: "Clickable ticket token link",
    isHtml: true,
    label: "Ticket",
  },
};

describe("ATTENDEE_TABLE_COLUMNS metadata", () => {
  test("every column exposes its expected label/description/className/isHtml", () => {
    for (const [key, expected] of Object.entries(METADATA)) {
      const col = ATTENDEE_TABLE_COLUMNS[key as AttendeeColumn];
      expect(col.label).toBe(expected.label);
      expect(col.description).toBe(expected.description);
      expect(col.isHtml).toBe(expected.isHtml);
      expect(col.className).toBe(expected.className);
      expect(col.headerClassName).toBe(expected.headerClassName);
      expect(col.headerText).toBe(expected.headerText);
    }
  });

  test("METADATA covers exactly the ATTENDEE_TABLE_COLUMNS keys", () => {
    expect(Object.keys(METADATA).sort()).toEqual(
      Object.keys(ATTENDEE_TABLE_COLUMNS).sort(),
    );
  });
});

describe("the attendee default column order", () => {
  test("is a permutation of ATTENDEE_TABLE_COLUMNS' keys", () => {
    expect([...COLUMN_LAYOUTS.attendee.defaultOrder].sort()).toEqual(
      Object.keys(ATTENDEE_TABLE_COLUMNS).sort(),
    );
  });
});

describe("ATTENDEE_TABLE_COLUMNS cell renderers", () => {
  /** The listings cell rendered for a two-listing grouped row */
  const twoListingCell = (): string =>
    ATTENDEE_TABLE_COLUMNS.listings!.cell(
      makeRow({
        listings: [
          { id: 42, name: "Gala" },
          { id: 7, name: "Quiz Night" },
        ],
      }),
      opts,
    );

  test("status cell delegates to opts.renderStatus, forwarding the row", () => {
    const row = makeRow({ attendee: testAttendee({ id: 7 }) });
    expect(ATTENDEE_TABLE_COLUMNS.status!.cell(row, opts)).toBe("");
    expect(
      ATTENDEE_TABLE_COLUMNS.status!.cell(row, {
        ...opts,
        renderStatus: (r) => `status for ${r.attendee.id}`,
      }),
    ).toBe("status for 7");
  });

  test("listings cell links every listing and carries the full list in its title", () => {
    expect(twoListingCell()).toBe(
      '<span class="listings-cell" title="Gala, Quiz Night">' +
        '<a href="/admin/listing/42">Gala</a>, ' +
        '<a href="/admin/listing/7">Quiz Night</a></span>',
    );
  });

  test("date cell formats date labels", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toBe("Sunday 15 March 2026");
  });

  test("date cell renders empty for null date", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: null }) }),
        opts,
      ),
    ).toBe("");
  });

  test("date rawValue returns date string for Liquid filters", () => {
    const row = makeRow({ attendee: testAttendee({ date: "2026-03-15" }) });
    expect(ATTENDEE_TABLE_COLUMNS.date!.rawValue!(row, opts)).toBe(
      "2026-03-15",
    );
  });

  test("date rawValue returns empty for null date", () => {
    const row = makeRow({ attendee: testAttendee({ date: null }) });
    expect(ATTENDEE_TABLE_COLUMNS.date!.rawValue!(row, opts)).toBe("");
  });

  test("name cell links to the attendee edit page with the escaped name", () => {
    const row = makeRow({
      attendee: testAttendee({ id: 9, name: "Jane Doe" }),
    });
    expect(ATTENDEE_TABLE_COLUMNS.name!.cell(row, opts)).toBe(
      '<a href="/admin/attendees/9">Jane Doe</a>',
    );
  });

  test("email cell renders the attendee's email address", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.email!.cell(
        makeRow({ attendee: testAttendee({ email: "jane@example.com" }) }),
        opts,
      ),
    ).toBe("jane@example.com");
  });

  test("email cell renders empty when email is empty", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.email!.cell(
        makeRow({ attendee: testAttendee({ email: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("phone cell renders clickable tel link with normalized number", () => {
    const html = ATTENDEE_TABLE_COLUMNS.phone!.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      opts,
    );
    expect(html).toBe('<a href="tel:+447700900000">07700 900000</a>');
  });

  test("phone cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.phone!.cell(
        makeRow({ attendee: testAttendee({ phone: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("phone cell defaults to prefix 44 when phonePrefix is empty", () => {
    const html = ATTENDEE_TABLE_COLUMNS.phone!.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      { ...opts, phonePrefix: "" },
    );
    expect(html).toContain("tel:+447700900000");
  });

  test("address cell formats a multi-line address inline", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.address!.cell(
        makeRow({ attendee: testAttendee({ address: "123 Main\nNew York" }) }),
        opts,
      ),
    ).toBe("123 Main, New York");
  });

  test("formatAddressInline returns empty for an empty address", () => {
    expect(formatAddressInline("")).toBe("");
  });

  test("special_instructions cell collapses newlines into spaces", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "VIP\nfront row" }),
        }),
        opts,
      ),
    ).toBe("VIP front row");
  });

  test("special_instructions cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("ticket cell renders a servicing indicator for servicing rows", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.ticket!.cell(
        makeRow({ attendee: testAttendee({ kind: "servicing" }) }),
        opts,
      ),
    ).toBe('<span class="muted small">Service</span>');
  });

  test("ticket cell renders a no-quantity indicator when quantity is 0", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.ticket!.cell(
        makeRow({
          attendee: testAttendee({ kind: "attendee", quantity: 0 }),
        }),
        opts,
      ),
    ).toBe('<span class="muted small">No quantity</span>');
  });

  test("ticket cell renders a ticket link with domain and token for a normal booking", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.ticket!.cell(
        makeRow({
          attendee: testAttendee({
            kind: "attendee",
            quantity: 1,
            ticket_token: "abc123",
          }),
        }),
        opts,
      ),
    ).toBe('<a href="https://example.com/t/abc123">abc123</a>');
  });

  test("registered cell renders formatted datetime", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.registered!.cell(
        makeRow({
          attendee: testAttendee({ created: "2026-01-01T12:00:00Z" }),
        }),
        opts,
      ),
    ).toContain("2026");
  });

  test("registered rawValue returns ISO string for Liquid filters", () => {
    const row = makeRow({
      attendee: testAttendee({ created: "2026-01-01T12:00:00Z" }),
    });
    expect(ATTENDEE_TABLE_COLUMNS.registered!.rawValue!(row, opts)).toBe(
      "2026-01-01T12:00:00Z",
    );
  });
});
