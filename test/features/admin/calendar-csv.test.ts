import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import {
  bookingAssignmentKey,
  type LogisticsAssignment,
} from "#db/logistics.ts";
import {
  type CalendarAttendee,
  type CalendarLogisticsCsv,
  generateCalendarCsv,
} from "#routes/admin/calendar-csv.ts";
import {
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { appleMapsUrl, googleMapsUrl } from "#shared/maps.ts";
import { testAttendee } from "#test-utils/factories.ts";

const CSV_DOMAIN = "calendar.example.com";
const ATTENDEE_HEADER =
  "Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL";
const CALENDAR_HEADER = `Listing,Type,Date,${ATTENDEE_HEADER}`;
const ATTENDEE_ROW = `John Doe,john@example.com,,,,1,2024-01-01T12:00:00.000Z,0.00,,No,test-token-1,https://${CSV_DOMAIN}/t/test-token-1`;
const CALENDAR_ROW = `Bouncy Castle,Attendee,2026-03-15,${ATTENDEE_ROW}`;
const ATTENDEE_ADDRESS_ROW = `John Doe,john@example.com,,1 High St,,1,2024-01-01T12:00:00.000Z,0.00,,No,test-token-1,https://${CSV_DOMAIN}/t/test-token-1`;
const CALENDAR_ADDRESS_ROW = `Bouncy Castle,Attendee,2026-03-15,${ATTENDEE_ADDRESS_ROW}`;
const LOGISTICS_HEADER = `${CALENDAR_HEADER},Start Agent,Start Time,End Agent,End Time,Map (Google),Map (Apple)`;

const calAttendee = (
  over: Partial<CalendarAttendee> = {},
): CalendarAttendee => ({
  ...testAttendee(over),
  date: "2026-03-15",
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

describe("generateCalendarCsv", () => {
  beforeAll(() => {
    setEffectiveDomainForTest(CSV_DOMAIN);
  });
  afterAll(resetEffectiveDomain);

  test("generates the base header for an empty export", () => {
    expect(generateCalendarCsv([])).toBe(CALENDAR_HEADER);
  });

  test("omits empty listing date and location columns", () => {
    expect(generateCalendarCsv([calAttendee()]).split("\n")).toEqual([
      CALENDAR_HEADER,
      CALENDAR_ROW,
    ]);
  });

  test("shows an inclusive date range for a multi-day booking", () => {
    expect(
      generateCalendarCsv([calAttendee({ end_date: "2026-03-18" })]).split(
        "\n",
      ),
    ).toEqual([
      CALENDAR_HEADER,
      `Bouncy Castle,Attendee,2026-03-15 to 2026-03-17,${ATTENDEE_ROW}`,
    ]);
  });

  test("includes exact listing date cells when only some rows have a listing date", () => {
    const csv = generateCalendarCsv([
      calAttendee({ listingDate: "2026-06-15T14:00:00.000Z" }),
      calAttendee({ id: 2, listingName: "Plain Listing" }),
    ]);
    expect(csv.split("\n")).toEqual([
      `Listing,Type,Listing Date,Date,${ATTENDEE_HEADER}`,
      `Bouncy Castle,Attendee,2026-06-15 15:00,2026-03-15,${ATTENDEE_ROW}`,
      `Plain Listing,Attendee,,2026-03-15,${ATTENDEE_ROW}`,
    ]);
  });

  test("includes exact listing location cells when only some rows have a location", () => {
    const csv = generateCalendarCsv([
      calAttendee({ listingLocation: "Village Hall" }),
      calAttendee({ id: 2, listingName: "Plain Listing" }),
    ]);
    expect(csv.split("\n")).toEqual([
      `Listing,Type,Listing Location,Date,${ATTENDEE_HEADER}`,
      `Bouncy Castle,Attendee,Village Hall,2026-03-15,${ATTENDEE_ROW}`,
      `Plain Listing,Attendee,,2026-03-15,${ATTENDEE_ROW}`,
    ]);
  });

  test("includes the booking date in its exact column", () => {
    const csv = generateCalendarCsv([calAttendee({ date: "2026-03-20" })]);
    expect(csv.split("\n")).toEqual([
      CALENDAR_HEADER,
      `Bouncy Castle,Attendee,2026-03-20,${ATTENDEE_ROW}`,
    ]);
  });

  test("escapes a listing name containing a comma", () => {
    const csv = generateCalendarCsv([
      calAttendee({ listingName: "Listing, Special" }),
    ]);
    expect(csv.split("\n")).toEqual([
      CALENDAR_HEADER,
      `"Listing, Special",Attendee,2026-03-15,${ATTENDEE_ROW}`,
    ]);
  });

  test("includes the exact standard attendee cells", () => {
    const csv = generateCalendarCsv([
      calAttendee({
        checked_in: true,
        created: "2024-01-15T10:30:00Z",
        payment_id: "pi_abc",
        price_paid: "2000",
        quantity: 2,
      }),
    ]);
    expect(csv.split("\n")).toEqual([
      CALENDAR_HEADER,
      `Bouncy Castle,Attendee,2026-03-15,John Doe,john@example.com,,,,2,2024-01-15T10:30:00.000Z,20.00,pi_abc,Yes,test-token-1,https://${CSV_DOMAIN}/t/test-token-1`,
    ]);
  });

  test("generates multiple exact rows", () => {
    const csv = generateCalendarCsv([
      calAttendee(),
      calAttendee({
        id: 2,
        listingName: "Other Listing",
        name: "Jane Smith",
      }),
    ]);
    expect(csv.split("\n")).toEqual([
      CALENDAR_HEADER,
      CALENDAR_ROW,
      `Other Listing,Attendee,2026-03-15,Jane Smith,john@example.com,,,,1,2024-01-01T12:00:00.000Z,0.00,,No,test-token-1,https://${CSV_DOMAIN}/t/test-token-1`,
    ]);
  });

  test("leaves the exact booking date cell blank when the date is null", () => {
    const csv = generateCalendarCsv([calAttendee({ date: null })]);
    expect(csv.split("\n")).toEqual([
      CALENDAR_HEADER,
      `Bouncy Castle,Attendee,,${ATTENDEE_ROW}`,
    ]);
  });

  describe("logistics columns", () => {
    test("omits logistics columns with no context", () => {
      const csv = generateCalendarCsv([calAttendee({ id: 1, listing_id: 1 })]);
      expect(csv.split("\n")).toEqual([CALENDAR_HEADER, CALENDAR_ROW]);
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
      expect(csv.split("\n")).toEqual([
        LOGISTICS_HEADER,
        `${CALENDAR_ADDRESS_ROW},Van A,09:00,Van B,17:00,${googleMapsUrl("1 High St")},${appleMapsUrl("1 High St")}`,
      ]);
    });

    test("leaves logistics columns blank for a non-logistics row", () => {
      const att = calAttendee({ address: "1 High St", id: 7, listing_id: 2 });
      const logistics: CalendarLogisticsCsv = {
        agentNames: new Map(),
        assignments: new Map(),
        // Listing 1 uses logistics, but this booking is for listing 2.
        listingIds: new Set([1]),
      };
      const csv = generateCalendarCsv([att], logistics);
      expect(csv.split("\n")).toEqual([CALENDAR_HEADER, CALENDAR_ADDRESS_ROW]);
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
      const csv = generateCalendarCsv(
        [logisticsRow, plainRow],
        vanALogistics(),
      );
      expect(csv.split("\n")).toEqual([
        LOGISTICS_HEADER,
        `${CALENDAR_ADDRESS_ROW},Van A,,,,${googleMapsUrl("1 High St")},${appleMapsUrl("1 High St")}`,
        `Workshop,Attendee,2026-03-15,${ATTENDEE_ROW},,,,,,`,
      ]);
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
      expect(csv.split("\n")).toEqual([
        LOGISTICS_HEADER,
        `${CALENDAR_ROW},,,,,,`,
        `${CALENDAR_ROW},,,,,,`,
      ]);
    });

    test("omits map links when a logistics booking has no address", () => {
      const att = calAttendee({ address: "", id: 7, listing_id: 1 });
      const csv = generateCalendarCsv([att], vanALogistics());
      expect(csv.split("\n")).toEqual([
        LOGISTICS_HEADER,
        `${CALENDAR_ROW},Van A,,,,,`,
      ]);
    });
  });

  describe("servicing policy", () => {
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
      expect(csv.split("\n")).toEqual([
        CALENDAR_HEADER,
        "Boiler Room,Service event,2026-03-15,Boiler Service,john@example.com,,,,1,2024-01-01T12:00:00.000Z,0.00,,No,svc-token,",
        `Boiler Room,Attendee,2026-03-15,Jane Doe,john@example.com,,,,1,2024-01-01T12:00:00.000Z,0.00,,No,att-token,https://${CSV_DOMAIN}/t/att-token`,
      ]);
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
      expect(csv.split("\n")).toEqual([
        LOGISTICS_HEADER,
        "Logistics Room,Service event,2026-03-15,Deep Clean,john@example.com,,,,1,2024-01-01T12:00:00.000Z,0.00,,No,svc-tok,,,,,,,",
      ]);
    });
  });
});
