/**
 * The roster's table receives rows the page already ordered through
 * attendeeListOrder — the same order the CSV export applies — so the table
 * must render them as given rather than re-sorting them.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import { AttendeesSection } from "#templates/admin/listings/attendees.tsx";
import { testRosterListSetup } from "#test-utils/attendee-list.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import type { AttendeeTableRow } from "#types";

describe("AttendeesSection", () => {
  test("keeps the order the caller chose, newest first", () => {
    // The page hands the table rows it already ordered — newest first here.
    // The table must render them as given: its own date-and-name order would
    // clobber the chosen registration order.
    const listing = testListingWithCount({ id: 5 });
    const rows: AttendeeTableRow[] = [
      { id: 3, name: "Zulu Person" },
      { id: 2, name: "Alpha Person" },
      { id: 1, name: "Mid Person" },
    ].map(({ id, name }) =>
      attendeeLineRow(testAttendee({ id, name }), listing),
    );
    const setup = testRosterListSetup();
    const html = String(
      AttendeesSection({
        allowedDomain: "example.com",
        emailDayHref: undefined,
        list: {
          setup,
          state: {
            checkin: "all",
            date: null,
            listingId: null,
            page: 0,
            sort: "newest",
            type: "all",
          },
        },
        phonePrefix: "44",
        questionData: undefined,
        returnUrl: setup.basePath,
        tableRows: rows,
      }),
    );
    const shown = ["Mid Person", "Alpha Person", "Zulu Person"]
      .map((name) => ({ at: html.indexOf(name), name }))
      .sort((first, second) => first.at - second.at)
      .map(({ name }) => name);
    expect(shown).toEqual(["Zulu Person", "Alpha Person", "Mid Person"]);
  });
});
