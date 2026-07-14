/**
 * Shared fixtures for the attendee form-model unit tests: one editor line,
 * one stored booking row, and one parsed form, each with sensible defaults
 * and per-test overrides.
 */

import type {
  AttendeeFormLine,
  ParsedAttendeeForm,
} from "#routes/admin/attendee-form-model.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

export const line = (
  overrides: Partial<AttendeeFormLine> = {},
): AttendeeFormLine => ({
  error: null,
  existingBooking: null,
  key: "",
  listing: testListingWithCount({ id: 1, max_quantity: 5 }),
  listingId: 1,
  noQuantity: false,
  packageGroupId: 0,
  packagePrice: null,
  parentListingId: 0,
  quantity: 1,
  ...overrides,
});

export const bookingRow = (
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

export const parsedBase = (
  overrides: Partial<ParsedAttendeeForm> = {},
): ParsedAttendeeForm => ({
  address: "",
  dayCount: 1,
  email: "",
  lines: [],
  name: "Test",
  phone: "",
  returnUrl: "",
  special_instructions: "",
  startDate: "",
  statusId: null,
  ...overrides,
});
