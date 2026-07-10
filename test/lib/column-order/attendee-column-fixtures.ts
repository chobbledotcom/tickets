import type { AttendeeTableRow } from "#shared/types.ts";
import type { AttendeeColumnOpts } from "#templates/attendee-table.tsx";
import { testAttendee } from "#test-utils/factories.ts";

/** Base AttendeeColumnOpts shared by ATTENDEE_TABLE_COLUMNS cell tests */
export const attendeeColumnOpts: AttendeeColumnOpts = {
  allowedDomain: "example.com",
  answerQuestionMap: new Map(),
  answerTextMap: new Map(),
  phonePrefix: "44",
  renderStatus: () => "",
};

/** An AttendeeTableRow with sensible defaults, for ATTENDEE_TABLE_COLUMNS cell tests */
export const makeAttendeeRow = (
  overrides: Partial<AttendeeTableRow> = {},
): AttendeeTableRow => ({
  attendee: testAttendee(),
  listings: [{ id: 1, name: "Test Listing" }],
  ...overrides,
});
