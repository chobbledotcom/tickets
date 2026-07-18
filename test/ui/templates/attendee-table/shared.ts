import { beforeAll, describe } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type {
  AttendeeTableOptions,
  AttendeeTableRow,
} from "#templates/attendee-table.tsx";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
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

export const attendeeTableSuite = (defineTests: () => void): void => {
  describe("AttendeeTable", () => {
    beforeAll(async () => {
      setupTestEncryptionKey();
      await signCsrfToken();
    });
    defineTests();
  });
};
