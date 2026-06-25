import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ATTENDEE_TABLE_COLUMNS } from "#shared/columns/attendee-columns.ts";
import { LISTING_TABLE_COLUMNS } from "#shared/columns/listing-columns.ts";
import type { AttendeeTableRow } from "#shared/types.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
import {
  setupTestEncryptionKey,
  testAttendee,
  testListingWithCount,
} from "#test-utils";

setupTestEncryptionKey();

describe("LISTING_TABLE_COLUMNS cell renderers", () => {
  const u = undefined as unknown;

  test("date cell formats date for display", () => {
    const col = LISTING_TABLE_COLUMNS.date!;
    expect(
      col.cell(testListingWithCount({ date: "2026-04-10T19:00:00Z" }), u),
    ).toContain("2026");
  });

  test("date cell renders empty for missing date", () => {
    const col = LISTING_TABLE_COLUMNS.date!;
    expect(col.cell(testListingWithCount({ date: "" }), u)).toBe("");
  });

  test("date rawValue returns date for Liquid filters", () => {
    expect(
      LISTING_TABLE_COLUMNS.date!.rawValue!(
        testListingWithCount({ date: "2026-04-10" }),
        u,
      ),
    ).toBe("2026-04-10");
  });

  test("date rawValue returns empty for missing date", () => {
    expect(
      LISTING_TABLE_COLUMNS.date!.rawValue!(
        testListingWithCount({ date: "" }),
        u,
      ),
    ).toBe("");
  });

  test("price cell renders numeric string for non-zero price", () => {
    expect(
      LISTING_TABLE_COLUMNS.price!.cell(
        testListingWithCount({ unit_price: 2500 }),
        u,
      ),
    ).toBe("2500");
  });

  test("price cell renders Free for zero price", () => {
    expect(
      LISTING_TABLE_COLUMNS.price!.cell(
        testListingWithCount({ unit_price: 0 }),
        u,
      ),
    ).toBe("Free");
  });

  test("status cell shows Active or Inactive", () => {
    expect(
      LISTING_TABLE_COLUMNS.status!.cell(
        testListingWithCount({ active: true }),
        u,
      ),
    ).toBe("Active");
    expect(
      LISTING_TABLE_COLUMNS.status!.cell(
        testListingWithCount({ active: false }),
        u,
      ),
    ).toBe("Inactive");
  });

  test("attendees cell shows count vs capacity", () => {
    expect(
      LISTING_TABLE_COLUMNS.attendees!.cell(
        testListingWithCount({ attendee_count: 5, max_attendees: 20 }),
        u,
      ),
    ).toBe("5 / 20");
  });

  test("tickets cell shows the tickets_count value", () => {
    expect(
      LISTING_TABLE_COLUMNS.tickets!.cell(
        testListingWithCount({ tickets_count: 7 }),
        u,
      ),
    ).toBe("7");
  });

  test("tickets rawValue returns tickets_count", () => {
    expect(
      LISTING_TABLE_COLUMNS.tickets!.rawValue!(
        testListingWithCount({ tickets_count: 7 }),
        u,
      ),
    ).toBe(7);
  });

  test("revenue cell formats income as currency", () => {
    expect(
      LISTING_TABLE_COLUMNS.revenue!.cell(
        testListingWithCount({ income: 7500 }),
        u,
      ),
    ).toContain("75");
  });

  test("revenue rawValue returns income", () => {
    expect(
      LISTING_TABLE_COLUMNS.revenue!.rawValue!(
        testListingWithCount({ income: 7500 }),
        u,
      ),
    ).toBe(7500);
  });

  test("cost cell formats servicing cost as currency", () => {
    expect(
      LISTING_TABLE_COLUMNS.cost!.cell(testListingWithCount({ cost: 2500 }), u),
    ).toContain("25");
  });

  test("cost rawValue returns cost", () => {
    expect(
      LISTING_TABLE_COLUMNS.cost!.rawValue!(
        testListingWithCount({ cost: 2500 }),
        u,
      ),
    ).toBe(2500);
  });

  test("profit cell formats income less cost as currency", () => {
    expect(
      LISTING_TABLE_COLUMNS.profit!.cell(
        testListingWithCount({ profit: 5000 }),
        u,
      ),
    ).toContain("50");
  });

  test("profit rawValue returns profit", () => {
    expect(
      LISTING_TABLE_COLUMNS.profit!.rawValue!(
        testListingWithCount({ profit: 5000 }),
        u,
      ),
    ).toBe(5000);
  });

  test("renewal cell renders label with months when months_per_unit > 0", () => {
    expect(
      LISTING_TABLE_COLUMNS.renewal!.cell(
        testListingWithCount({ months_per_unit: 3 }),
        u,
      ),
    ).toBe("Renewal (3mo)");
  });

  test("renewal cell renders empty when months_per_unit is 0", () => {
    expect(
      LISTING_TABLE_COLUMNS.renewal!.cell(
        testListingWithCount({ months_per_unit: 0 }),
        u,
      ),
    ).toBe("");
  });

  test("renewal rawValue returns months_per_unit", () => {
    expect(
      LISTING_TABLE_COLUMNS.renewal!.rawValue!(
        testListingWithCount({ months_per_unit: 6 }),
        u,
      ),
    ).toBe(6);
  });
});

describe("ATTENDEE_TABLE_COLUMNS cell renderers", () => {
  const opts: AttendeeColumnOpts = {
    allowedDomain: "example.com",
    answerQuestionMap: new Map(),
    answerTextMap: new Map(),
    phonePrefix: "44",
    renderStatus: () => "",
  };
  const makeRow = (
    overrides: Partial<AttendeeTableRow> = {},
  ): AttendeeTableRow => ({
    attendee: testAttendee(),
    listingId: 1,
    listingName: "Test Listing",
    ...overrides,
  });

  test("listing cell renders link to admin listing page", () => {
    const html = ATTENDEE_TABLE_COLUMNS.listing!.cell(
      makeRow({ listingId: 42, listingName: "Gala" }),
      opts,
    );
    expect(html).toContain("/admin/listing/42");
    expect(html).toContain("Gala");
  });

  test("date cell formats date labels", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.date!.cell(
        makeRow({ attendee: testAttendee({ date: "2026-03-15" }) }),
        opts,
      ),
    ).toContain("March");
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

  test("phone cell renders clickable tel link with normalized number", () => {
    const html = ATTENDEE_TABLE_COLUMNS.phone!.cell(
      makeRow({ attendee: testAttendee({ phone: "07700 900000" }) }),
      opts,
    );
    expect(html).toContain("tel:+447700900000");
    expect(html).toContain("07700 900000");
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

  test("address cell formats multi-line address inline", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.address!.cell(
        makeRow({ attendee: testAttendee({ address: "123 Main\nNew York" }) }),
        opts,
      ),
    ).toContain("123 Main");
  });

  test("special_instructions cell collapses newlines", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({
          attendee: testAttendee({ special_instructions: "VIP\nfront row" }),
        }),
        opts,
      ),
    ).toContain("VIP");
  });

  test("special_instructions cell renders empty when not provided", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.special_instructions!.cell(
        makeRow({ attendee: testAttendee({ special_instructions: "" }) }),
        opts,
      ),
    ).toBe("");
  });

  test("ticket cell renders full URL with domain and token", () => {
    expect(
      ATTENDEE_TABLE_COLUMNS.ticket!.cell(
        makeRow({ attendee: testAttendee({ ticket_token: "abc123" }) }),
        opts,
      ),
    ).toContain("example.com/t/abc123");
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
