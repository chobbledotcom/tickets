import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type {
  AttendeeFormLine,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
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
        data: data([
          line(),
          line({ listingId: 2, packageGroupId: 10 }),
          line({ listingId: 3, packageGroupId: 11 }),
          line({ listingId: 4, parentListingId: 20 }),
          line({ listingId: 5, parentListingId: 21 }),
        ]),
      }),
    );

    expect(html).toContain('class="listing-editor show-all-listings"');
    expect(html).not.toContain('class="show-all-toggle"');
    expect(html).toContain('class="package-paths-toggle"');
    expect(html).toContain("via Weekend pass");
    expect(html).toContain("via deleted package #11");
    expect(html).toContain("add-on under Main tour");
    expect(html).toContain("add-on under 21");
    expect(html).toContain('name="line_package_1"');
    expect(html).toContain("attendee-line-package-blank");
    expect(html).toContain("attendee-line-empty");
    expect(html).toContain("Fixed date");
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
        data: data([bookedLine], {
          lineWarnings: new Map([[1, ["This booking is over capacity."]]]),
        }),
      }),
    );

    expect(html).toContain('class="listing-editor"');
    expect(html).toContain('class="show-all-toggle"');
    expect(html).toContain('class="attendee-line"');
    expect(html).toContain("Shared dates");
    expect(html).toContain("Choose a smaller quantity.");
    expect(html).toContain("This booking is over capacity.");
    expect(html).toContain("Checked in");
    expect(html).toContain("Refunded");
    expect(html).toContain("Inactive");
    expect(html).toContain(
      'class="no-quantity-toggle" disabled name="noqty_0"',
    );
    expect(html).toContain('max="3"');
    expect(html).toContain('name="line_key_0"');
    expect(html).toContain('value="1|2026-07-01"');
  });
});
