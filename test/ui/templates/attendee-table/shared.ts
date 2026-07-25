import { beforeAll, describe } from "@std/testing/bdd";
import type {
  AttendeeTableOptions,
  AttendeeTableRow,
} from "#templates/attendee-table.tsx";
import { AttendeeTable } from "#templates/attendee-table.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee } from "#test-utils/factories.ts";

export const ALLOWED_DOMAIN = "example.com";

export const makeRow = (
  overrides: Partial<AttendeeTableRow> = {},
): AttendeeTableRow => ({
  attendee: testAttendee(),
  listings: [{ id: 1, name: "Test Listing" }],
  ...overrides,
});

export const namedListingRow = (
  name: string,
  attendee = testAttendee(),
): AttendeeTableRow => makeRow({ attendee, listings: [{ id: 1, name }] });

export const makeOpts = (
  overrides: Partial<AttendeeTableOptions> = {},
): AttendeeTableOptions => ({
  allowedDomain: ALLOWED_DOMAIN,
  rows: [makeRow()],
  showDate: false,
  showListing: false,
  ...overrides,
});

export const zaraAliceRows = (): AttendeeTableRow[] => [
  namedListingRow("B Listing", testAttendee({ id: 1, name: "Zara" })),
  namedListingRow("A Listing", testAttendee({ id: 2, name: "Alice" })),
];

/** Render the attendee table to an HTML string for assertion. The renderer
 *  returns `JSX.Element` (SafeHtml) at runtime; tests want a plain string for
 *  `toContain`/`matchAll`/`indexOf`. */
export const render = (opts: AttendeeTableOptions): string =>
  String(AttendeeTable(opts));

export const attendeeTableSuite = (defineTests: () => void): void => {
  describe("AttendeeTable", () => {
    beforeAll(setupAdminPageTest);
    defineTests();
  });
};
