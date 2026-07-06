import type { AttendeeTableRow } from "#shared/types.ts";
import { testAttendee } from "#test-utils/factories.ts";

/** A plain attendee-table row: one test attendee on a single "Test Listing"
 *  (id 1), with any field overridden. Shared by the attendee-table and
 *  column-order tests, which both build rows from this same shape. */
export const makeAttendeeRow = (
  overrides: Partial<AttendeeTableRow> = {},
): AttendeeTableRow => ({
  attendee: testAttendee(),
  listings: [{ id: 1, name: "Test Listing" }],
  ...overrides,
});
