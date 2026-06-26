import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type CalendarAttendee,
  type CalendarLogisticsCsv,
  generateCalendarCsv,
} from "#routes/admin/calendar-csv.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  bookingAssignmentKey,
  type LogisticsAssignment,
} from "#shared/db/logistics.ts";
import { appleMapsUrl, googleMapsUrl } from "#shared/maps.ts";
import { setupTestEncryptionKey, testAttendee } from "#test-utils";

const calAttendee = (
  over: Partial<CalendarAttendee> = {},
): CalendarAttendee => ({
  ...testAttendee(over),
  listingDate: "",
  listingLocation: "",
  listingName: "Bouncy Castle",
  ...over,
});

/** The standard logistics context: agent 5 = "Van A", assigned to
 *  attendee 7 / listing 1 as the start agent. Used by the "adds columns",
 *  "omits map links when no address", and "tolerates missing assignment"
 *  tests. */
const vanALogistics = (
  assignments?: Map<string, LogisticsAssignment>,
): CalendarLogisticsCsv => ({
  agentNames: new Map([[5, "Van A"]]),
  assignments:
    assignments ??
    new Map([
      [
        bookingAssignmentKey(7, 1),
        { endAgentId: null, endTime: "", startAgentId: 5, startTime: "" },
      ],
    ]),
  listingIds: new Set([1]),
});

describe("generateCalendarCsv logistics columns", () => {
  beforeAll(() => {
    setupTestEncryptionKey();
    signCsrfToken();
  });

  test("omits logistics columns with no context", () => {
    const csv = generateCalendarCsv([calAttendee({ id: 1, listing_id: 1 })]);
    expect(csv).not.toContain("Start Agent");
  });

  test("adds agent, time, and map columns for a logistics booking", () => {
    const att = calAttendee({ address: "1 High St", id: 7, listing_id: 1 });
    const logistics: CalendarLogisticsCsv = {
      agentNames: new Map([
        [5, "Van A"],
        [6, "Van B"],
      ]),
      assignments: new Map([
        [
          bookingAssignmentKey(7, 1),
          {
            endAgentId: 6,
            endTime: "17:00",
            startAgentId: 5,
            startTime: "09:00",
          },
        ],
      ]),
      listingIds: new Set([1]),
    };
    const csv = generateCalendarCsv([att], logistics);
    expect(csv).toContain("Start Agent,Start Time,End Agent,End Time");
    expect(csv).toContain("Van A");
    expect(csv).toContain("Van B");
    expect(csv).toContain("09:00");
    expect(csv).toContain("17:00");
    expect(csv).toContain(googleMapsUrl("1 High St"));
    expect(csv).toContain(appleMapsUrl("1 High St"));
  });

  test("leaves logistics columns blank for a non-logistics row", () => {
    const att = calAttendee({ address: "1 High St", id: 7, listing_id: 2 });
    const logistics: CalendarLogisticsCsv = {
      agentNames: new Map(),
      assignments: new Map(),
      // Listing 1 uses logistics, but this booking is for listing 2.
      listingIds: new Set([1]),
    };
    // No logistics row present → no logistics columns at all.
    const csv = generateCalendarCsv([att], logistics);
    expect(csv).not.toContain("Start Agent");
  });

  test("blanks the logistics columns for a non-logistics row in a mixed export", () => {
    const logisticsRow = calAttendee({
      address: "1 High St",
      id: 7,
      listing_id: 1,
    });
    const plainRow = calAttendee({
      id: 8,
      listing_id: 2,
      listingName: "Workshop",
    });
    const csv = generateCalendarCsv([logisticsRow, plainRow], vanALogistics());
    const lines = csv.split("\n");
    // The non-logistics row ends with the six empty logistics columns.
    expect(lines.find((l) => l.startsWith("Workshop"))).toMatch(/,,,,,,$/);
  });

  test("tolerates a missing assignment and an unknown agent id", () => {
    const withUnknownAgent = calAttendee({ id: 7, listing_id: 1 });
    const withoutAssignment = calAttendee({ id: 8, listing_id: 1 });
    const logistics: CalendarLogisticsCsv = {
      agentNames: new Map(), // no names → unknown agent id resolves to ""
      assignments: new Map([
        [
          bookingAssignmentKey(7, 1),
          { endAgentId: null, endTime: "", startAgentId: 99, startTime: "" },
        ],
        // id 8 has no assignment entry at all.
      ]),
      listingIds: new Set([1]),
    };
    const csv = generateCalendarCsv(
      [withUnknownAgent, withoutAssignment],
      logistics,
    );
    expect(csv).toContain("Start Agent");
  });

  test("omits map links when a logistics booking has no address", () => {
    const att = calAttendee({ address: "", id: 7, listing_id: 1 });
    const csv = generateCalendarCsv([att], vanALogistics());
    expect(csv).toContain("Start Agent");
    expect(csv).toContain("Van A");
    expect(csv).not.toContain("maps.apple.com");
  });
});
