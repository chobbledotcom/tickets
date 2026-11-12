import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type {
  AttendeeFormLine,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import { formatDateRangeLabel } from "#shared/date-labels.ts";
import { ListingEditor } from "#templates/admin/attendee-form/listing-editor.tsx";
import type { AttendeeFormTemplateData } from "#templates/admin/attendee-form/types.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { attendeeFormLine } from "#test-utils/attendee-form-factories.ts";
import { bookingRow, testListingWithCount } from "#test-utils/factories.ts";
import { formData } from "./fixtures.ts";

const parsed = (lines: AttendeeFormLine[]): ParsedAttendeeForm => ({
  address: "",
  adjustments: [null, null, null],
  dayCount: 1,
  email: "",
  lines,
  name: "Test",
  payments: [null, null, null],
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
});

const data = (
  lines: AttendeeFormLine[],
  overrides: Partial<AttendeeFormTemplateData> = {},
): AttendeeFormTemplateData => formData(parsed(lines), overrides);

describe("ListingEditor", () => {
  beforeAll(setupAdminPageTest);

  test("shows every blank booking path and labels its source", () => {
    const html = String(
      ListingEditor({
        data: data(
          [
            attendeeFormLine(),
            attendeeFormLine({ listingId: 2, packageGroupId: 10 }),
            attendeeFormLine({ listingId: 3, packageGroupId: 11 }),
            attendeeFormLine({ listingId: 4, parentListingId: 20 }),
            attendeeFormLine({ listingId: 5, parentListingId: 21 }),
            attendeeFormLine({ listingId: 6, packageGroupId: 1 }),
            attendeeFormLine({ listingId: 7, parentListingId: 1 }),
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

    assertStringIncludes(html, 'class="listing-editor show-all-listings"');
    assert(!html.includes('class="show-all-toggle"'));
    expectIncludesAll(html, [
      '<label class="show-all"><input class="package-paths-toggle" type="checkbox">',
      '<span class="muted small booking-path"> via Weekend pass</span>',
      "via Day pass",
      "via deleted package #11",
      "add-on under Main tour",
      "add-on under 1",
      '<tr class="attendee-line attendee-line-package-blank">',
      '<tr class="attendee-line attendee-line-empty">',
      '<span class="muted small">Fixed date</span>',
      'name="line_package_1"',
    ]);
    expect(html.match(/name="line_package_\d+"/g)).toHaveLength(3);
    expectIncludesAll(html, [
      'class="line-qty" max="5" min="0" name="qty_0" type="number" value="0"',
      "Fixed date",
    ]);
  });

  test("carries one lowest-value package path on its own", () => {
    // A package id of 1 keeps every "is this a package path?" check honest.
    const html = String(
      ListingEditor({
        data: data(
          [attendeeFormLine({ key: "p", listingId: 2, packageGroupId: 1 })],
          {
            packageNamesById: new Map([[1, "Day pass"]]),
          },
        ),
      }),
    );

    expectIncludesAll(html, [
      'class="package-paths-toggle"',
      "via Day pass",
      '<tr class="attendee-line attendee-line-package-blank">',
      '<input name="line_package_0" type="hidden" value="1">',
    ]);
  });

  test("keeps a plain selected line booked without a stored booking", () => {
    // A quantity picked on the form (no stored booking yet) still counts as a
    // booked line, so the editor stays in its filtered shape.
    const html = String(
      ListingEditor({
        data: data([attendeeFormLine({ key: "s", quantity: 1 })]),
      }),
    );

    expectIncludesAll(html, [
      'class="listing-editor"',
      'class="show-all-toggle"',
      '<label class="show-all">',
      '<tr class="attendee-line">',
    ]);
    assert(!html.includes("attendee-line-empty"));
    assert(!html.includes("attendee-line-package-blank"));
  });

  test("gives create mode an agreed-price box per row", () => {
    const html = String(
      ListingEditor({
        data: data([attendeeFormLine({ key: "s", quantity: 1 })]),
      }),
    );
    expectIncludesAll(html, [
      "<th>Agreed price</th>",
      '<td class="attendee-line-price"><input aria-label="Agreed price for Test Listing" class="line-price" min="0" name="price_0" placeholder="0" title="Optional, in pence or cents. Blank uses this row\'s usual price." type="number" value=""></td>',
    ]);
  });

  test("a zero package price placeholders zero, not the listing price", () => {
    const html = String(
      ListingEditor({
        data: data([
          attendeeFormLine({
            listing: testListingWithCount({ id: 9, unit_price: 900 }),
            listingId: 9,
            packageGroupId: 4,
            packagePrice: 0,
          }),
        ]),
      }),
    );
    assertStringIncludes(html, 'placeholder="0"');
    assert(!html.includes('placeholder="900"'));
  });

  test("edit mode has no agreed-price box", () => {
    const html = String(
      ListingEditor({
        data: data([attendeeFormLine({ key: "s", quantity: 1 })], {
          mode: "edit",
        }),
      }),
    );
    assert(!html.includes("Agreed price"));
    assert(!html.includes('name="price_0"'));
  });

  test("keeps a paid daily booking visible with its notices", () => {
    const existingBooking = bookingRow({
      checked_in: 1,
      end_at: "2026-07-03T00:00:00Z",
      price_paid: 1500,
      refunded: 1,
      start_at: "2026-07-01T00:00:00Z",
    });
    const bookedLine = attendeeFormLine({
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
            attendeeFormLine({ key: "s", quantity: 1 }),
            attendeeFormLine({
              existingBooking: bookingRow(),
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

    expectIncludesAll(html, [
      'class="listing-editor"',
      '<label class="show-all"><input class="show-all-toggle" type="checkbox">',
    ]);
    expect(html.match(/class="attendee-line"/g)).toHaveLength(3);
    assert(!html.includes("attendee-line-empty"));
    assert(!html.includes("package-paths-toggle"));
    expectIncludesAll(html, [
      '<table class="line-editor">',
      'class="line-qty" max="3" min="0" name="qty_0" type="number" value="2"',
      'class="line-qty" max="5" min="0" name="qty_1" type="number" value="1"',
      '<span class="muted small">Shared dates</span>',
      `<div class="muted small">${formatDateRangeLabel("2026-07-01T00:00:00Z", "2026-07-03T00:00:00Z")}</div>`,
      '<div class="warning small" role="alert">This booking is over capacity.</div>',
      '<td class="attendee-line-qty">',
      "<th></th>",
      '<label class="small">',
      "Choose a smaller quantity.",
      "Checked in",
      "Refunded",
      "Inactive",
      'class="no-quantity-toggle" disabled name="noqty_0"',
      'name="noqty_0" title="Refund this line',
      'type="checkbox" value="1"',
      '<input name="line_listing_0" type="hidden" value="1">',
      '<input name="line_key_0" type="hidden" value="1|2026-07-01">',
    ]);
  });
});
