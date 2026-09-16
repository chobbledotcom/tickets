/**
 * Ready-made attendee-list setups for tests: a browser-shaped list (listings,
 * types, paging, newest first) and a roster-shaped list (check-in and days,
 * the table's own order), each overridable per test.
 */

import {
  type AttendeeListSetup,
  type AttendeeListState,
  type AttendeeSort,
  readAttendeeListState,
} from "#shared/attendee-list-controls.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** Read one setup's state from a query string, the way a test writes queries. */
export const readListState = <Sort extends AttendeeSort | null>(
  setup: AttendeeListSetup<Sort>,
  query: string,
): AttendeeListState<Sort> =>
  readAttendeeListState(setup, new URLSearchParams(query));

export const testBrowserListSetup = (
  overrides: Partial<AttendeeListSetup<AttendeeSort>> = {},
): AttendeeListSetup<AttendeeSort> => ({
  basePath: "/admin/attendees",
  csvPath: "/admin/attendees/csv",
  dates: [],
  defaultSort: "newest",
  listings: [
    testListingWithCount({ id: 7, name: "Festival" }),
    testListingWithCount({ id: 9, name: "Quiz Night" }),
  ],
  withCheckin: false,
  withDates: false,
  withPaging: true,
  withTypes: true,
  ...overrides,
});

export const testRosterListSetup = (
  overrides: Partial<AttendeeListSetup<null>> = {},
): AttendeeListSetup<null> => ({
  basePath: "/admin/listing/5/attendees",
  csvPath: "/admin/listing/5/export",
  dates: [{ label: "3 August", value: "2026-08-03" }],
  defaultSort: null,
  listings: [],
  withCheckin: true,
  withDates: true,
  withPaging: false,
  withTypes: false,
  ...overrides,
});
