import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type CalendarAttendee,
  type CalendarLogisticsCsv,
  generateCalendarCsv,
} from "#routes/admin/calendar-csv.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { bookingAssignmentKey } from "#shared/db/logistics.ts";
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
    const logistics: CalendarLogisticsCsv = {
      agentNames: new Map([[5, "Van A"]]),
      assignments: new Map([
        [
          bookingAssignmentKey(7, 1),
          { endAgentId: null, endTime: "", startAgentId: 5, startTime: "" },
        ],
      ]),
      listingIds: new Set([1]),
    };
    const csv = generateCalendarCsv([logisticsRow, plainRow], logistics);
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
    const logistics: CalendarLogisticsCsv = {
      agentNames: new Map([[5, "Van A"]]),
      assignments: new Map([
        [
          bookingAssignmentKey(7, 1),
          { endAgentId: null, endTime: "", startAgentId: 5, startTime: "" },
        ],
      ]),
      listingIds: new Set([1]),
    };
    const csv = generateCalendarCsv([att], logistics);
    expect(csv).toContain("Start Agent");
    expect(csv).toContain("Van A");
    expect(csv).not.toContain("maps.apple.com");
  });
});

describe("generateCalendarCsv servicing policy", () => {
  beforeAll(() => {
    setupTestEncryptionKey();
    signCsrfToken();
  });

  test("marks servicing rows as 'Service event' and omits their dead /t/ ticket URL", () => {
    // The calendar includes servicing holds (operator decision), so the CSV
    // includes them too — but marked by a Type column and with no followable
    // ticket URL: a servicing token's `/t/:token` 404s (kind filter), and a dead
    // link must never be rendered. A real attendee keeps its ticket URL.
    const service = calAttendee({
      id: 1,
      kind: SERVICING_KIND,
      listing_id: 1,
      listingName: "Boiler Room",
      name: "Boiler Service",
      ticket_token: "svc-token",
    });
    const attendee = calAttendee({
      id: 2,
      listing_id: 1,
      listingName: "Boiler Room",
      name: "Jane Doe",
      ticket_token: "att-token",
    });
    const csv = generateCalendarCsv([service, attendee]);
    expect(csv).toContain("Type");
    expect(csv).toContain("Service event");
    expect(csv).toContain("Attendee");
    // The servicing row's dead ticket URL is omitted; the attendee's is kept.
    expect(csv).not.toContain("/t/svc-token");
    expect(csv).toContain("/t/att-token");
  });

  test("keeps a servicing row as 'Service event' on a logistics listing", () => {
    const service = calAttendee({
      id: 1,
      kind: SERVICING_KIND,
      listing_id: 1,
      listingName: "Logistics Room",
      name: "Deep Clean",
      ticket_token: "svc-tok",
    });
    const logistics: CalendarLogisticsCsv = {
      agentNames: new Map([[5, "Van A"]]),
      assignments: new Map(),
      listingIds: new Set([1]),
    };
    const csv = generateCalendarCsv([service], logistics);
    // Logistics columns render (listing 1 uses logistics), but the servicing
    // row is still labelled "Service event" — a hold, not a logisticable booking.
    expect(csv).toContain("Service event");
    expect(csv).toContain("Start Agent");
  });
});
