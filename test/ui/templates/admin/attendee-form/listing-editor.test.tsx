import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import type {
  AttendeeFormLine,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import { ListingEditor } from "#templates/admin/attendee-form/listing-editor.tsx";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const line = (overrides: Partial<AttendeeFormLine> = {}): AttendeeFormLine => ({
  error: null,
  existingBooking: null,
  key: "",
  listing: testListingWithCount({ id: 1, max_quantity: 5 }),
  listingId: 1,
  noQuantity: false,
  packageGroupId: 0,
  packagePrice: null,
  parentListingId: 0,
  quantity: null,
  ...overrides,
});

const booking = (
  overrides: Partial<ListingAttendeeRow> = {},
): ListingAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  ledger_event_group: "",
  listing_id: 1,
  order_token: "",
  package_group_id: 0,
  parent_listing_id: 0,
  price_paid: 0,
  quantity: 1,
  refunded: 0,
  start_at: null,
  ...overrides,
});

const parsed = (lines: AttendeeFormLine[]): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines,
  name: "Test",
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
});

const data = (
  lines: AttendeeFormLine[],
  overrides: Partial<AttendeeFormTemplateData> = {},
): AttendeeFormTemplateData => ({
  attendee: null,
  attendeeError: null,
  balanceNotice: null,
  dateError: null,
  formError: null,
  hasDailyListings: false,
  hasMixedTimings: false,
  lineWarnings: new Map(),
  mode: "create",
  packageNamesById: new Map([[10, "Weekend pass"]]),
  parentNamesById: new Map([[20, "Main tour"]]),
  parsed: parsed(lines),
  questions: [],
  selectedAnswerIds: [],
  selectedTextAnswers: new Map(),
  statuses: [],
  topWarnings: [],
  ...overrides,
});

describe("ListingEditor", () => {
  beforeAll(setupAdminPageTest);

  test("shows every blank booking path and labels its source", () => {
    const html = String(
      ListingEditor({
        data: data(
          [
            line(),
            line({ listingId: 2, packageGroupId: 10 }),
            line({ listingId: 3, packageGroupId: 11 }),
            line({ listingId: 4, parentListingId: 20 }),
            line({ listingId: 5, parentListingId: 21 }),
            line({ listingId: 6, packageGroupId: 1 }),
            line({ listingId: 7, parentListingId: 1 }),
          ],
          {
            packageNamesById: new Map([
              [10, "Weekend pass"],
              [1, "Day pass"],
            ]),
          },
        ),
      }),
    );

    expect(html).toContain('class="listing-editor show-all-listings"');
    expect(html).not.toContain('class="show-all-toggle"');
    expect(html).toContain(
      '<label class="show-all"><input class="package-paths-toggle" name="show_package_paths" type="checkbox">',
    );
    expect(html).toContain(
      '<span class="muted small booking-path"> via Weekend pass</span>',
    );
    expect(html).toContain("via Day pass");
    expect(html).toContain("via deleted package #11");
    expect(html).toContain("add-on under Main tour");
    expect(html).toContain("add-on under 1");
    expect(html).toContain(
      '<tr class="attendee-line attendee-line-package-blank">',
    );
    expect(html).toContain('<tr class="attendee-line attendee-line-empty">');
    expect(html).toContain('<span class="muted small">Fixed date</span>');
    expect(html).toContain('name="line_package_1"');
    expect(html.match(/name="line_package_\d+"/g)).toHaveLength(3);
    expect(html).toContain(
      'class="line-qty" max="5" min="0" name="qty_0" type="number" value="0"',
    );
    expect(html).toContain("Fixed date");
  });

  test("carries one lowest-value package path on its own", () => {
    // A package id of 1 keeps every "is this a package path?" check honest.
    const html = String(
      ListingEditor({
        data: data([line({ key: "p", listingId: 2, packageGroupId: 1 })], {
          packageNamesById: new Map([[1, "Day pass"]]),
        }),
      }),
    );

    expect(html).toContain('class="package-paths-toggle"');
    expect(html).toContain("via Day pass");
    expect(html).toContain(
      '<tr class="attendee-line attendee-line-package-blank">',
    );
    expect(html).toContain(
      '<input name="line_package_0" type="hidden" value="1">',
    );
  });

  test("keeps a plain selected line booked without a stored booking", () => {
    // A quantity picked on the form (no stored booking yet) still counts as a
    // booked line, so the editor stays in its filtered shape.
    const html = String(
      ListingEditor({ data: data([line({ key: "s", quantity: 1 })]) }),
    );

    expect(html).toContain('class="listing-editor"');
    expect(html).toContain('class="show-all-toggle"');
    expect(html).toContain('<label class="show-all">');
    expect(html).toContain('<tr class="attendee-line">');
    expect(html).not.toContain("attendee-line-empty");
    expect(html).not.toContain("attendee-line-package-blank");
  });

  test("keeps a paid daily booking visible with its notices", () => {
    const existingBooking = booking({
      checked_in: 1,
      end_at: "2026-07-03T00:00:00Z",
      price_paid: 1500,
      refunded: 1,
      start_at: "2026-07-01T00:00:00Z",
    });
    const bookedLine = line({
      error: "Choose a smaller quantity.",
      existingBooking,
      key: "1|2026-07-01",
      listing: testListingWithCount({
        active: false,
        id: 1,
        listing_type: "daily",
        max_quantity: 3,
        name: "Summer camp",
      }),
      noQuantity: true,
      quantity: 2,
    });
    const html = String(
      ListingEditor({
        data: data(
          [
            bookedLine,
            line({ key: "s", quantity: 1 }),
            line({
              existingBooking: booking(),
              key: "p",
              packageGroupId: 10,
              quantity: 1,
            }),
          ],
          {
            lineWarnings: new Map([[1, ["This booking is over capacity."]]]),
          },
        ),
      }),
    );

    expect(html).toContain('class="listing-editor"');
    expect(html).toContain(
      '<label class="show-all"><input class="show-all-toggle" name="show_all" type="checkbox">',
    );
    expect(html.match(/class="attendee-line"/g)).toHaveLength(3);
    expect(html).not.toContain("attendee-line-empty");
    expect(html).not.toContain("package-paths-toggle");
    expect(html).toContain('<table class="line-editor">');
    expect(html).toContain(
      'class="line-qty" max="3" min="0" name="qty_0" type="number" value="2"',
    );
    expect(html).toContain(
      'class="line-qty" max="5" min="0" name="qty_1" type="number" value="1"',
    );
    expect(html).toContain('<span class="muted small">Shared dates</span>');
    expect(html).toContain(
      `<div class="muted small">${formatDateRangeLabel("2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z")}</div>`,
    );
    expect(html).toContain(
      '<div class="warning small" role="alert">This booking is over capacity.</div>',
    );
    expect(html).toContain('<td class="attendee-line-qty">');
    expect(html).toContain("<th></th>");
    expect(html).toContain('<label class="small">');
    expect(html).toContain("Choose a smaller quantity.");
    expect(html).toContain("Checked in");
    expect(html).toContain("Refunded");
    expect(html).toContain("Inactive");
    expect(html).toContain(
      'class="no-quantity-toggle" disabled name="noqty_0"',
    );
    expect(html).toContain('name="noqty_0" title="Refund this line');
    expect(html).toContain('type="checkbox" value="1"');
    expect(html).toContain(
      '<input name="line_listing_0" type="hidden" value="1">',
    );
    expect(html).toContain(
      '<input name="line_key_0" type="hidden" value="1|2026-07-01">',
    );
  });
});
