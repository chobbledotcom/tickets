import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  adminCalendarPage,
  type CalendarAttendeeRow,
} from "#templates/admin/calendar.tsx";
import { adminDashboardPage } from "#templates/admin/dashboard.tsx";
import { generateCalendarCsv } from "#templates/csv.ts";
import { setupTestEncryptionKey, testAttendee } from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

const calendarAttendee = (
  overrides: Partial<CalendarAttendeeRow> = {},
): CalendarAttendeeRow => ({
  ...testAttendee(),
  date: "2026-03-15",
  durationDays: 1,
  listingDate: "",
  listingId: 1,
  listingLocation: "",
  listingName: "Daily Listing",
  ...overrides,
});

describe("adminCalendarPage", () => {
  test("renders Calendar title", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      [],
      "2026-03-10",
    );
    expect(html).toContain("Calendar");
    expect(html).toContain("Attendees by Date");
  });

  test("renders date selector dropdown", () => {
    const dates = [
      {
        hasBookings: true,
        label: "Sunday 15 March 2026",
        value: "2026-03-15",
      },
      {
        hasBookings: false,
        label: "Monday 16 March 2026",
        value: "2026-03-16",
      },
    ];
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      dates,
      "2026-03-10",
    );
    expect(html).toContain("Sunday 15 March 2026");
    expect(html).toContain("Monday 16 March 2026");
    expect(html).toContain("Select a date");
  });

  test("disables options for dates without bookings", () => {
    const dates = [
      {
        hasBookings: false,
        label: "Sunday 15 March 2026",
        value: "2026-03-15",
      },
    ];
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      dates,
      "2026-03-10",
    );
    expect(html).toContain("<option disabled>");
  });

  test("enables options for dates with bookings", () => {
    const dates = [
      {
        hasBookings: true,
        label: "Sunday 15 March 2026",
        value: "2026-03-15",
      },
    ];
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      dates,
      "2026-03-10",
    );
    expect(html).toContain('value="/admin/calendar?date=2026-03-15#attendees"');
  });

  test("shows prompt when no date selected", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      [],
      "2026-03-10",
    );
    expect(html).toContain("Select a date above to view attendees");
  });

  test("shows no attendees message when date selected but empty", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).toContain("No attendees for this date");
  });

  test("shows formatted date label when date is selected", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).toContain("Sunday 15 March 2026");
  });

  test("renders attendee rows with listing name and link", () => {
    const attendees = [calendarAttendee()];
    const html = adminCalendarPage(
      attendees,
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).toContain("Daily Listing");
    expect(html).toContain('href="/admin/listing/1"');
    expect(html).toContain("John Doe");
  });

  test("renders Listing column header", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      [],
      "2026-03-10",
    );
    expect(html).toContain("<th>Listing</th>");
  });

  test("shows CSV export link when date has attendees", () => {
    const attendees = [calendarAttendee()];
    const html = adminCalendarPage(
      attendees,
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).toContain('href="/admin/calendar/export?date=2026-03-15"');
    expect(html).toContain("Export CSV");
  });

  test("does not show CSV export when date has no attendees", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).not.toContain("Export CSV");
  });

  test("does not show CSV export when no date selected", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      [],
      "2026-03-10",
    );
    expect(html).not.toContain("Export CSV");
  });

  test("includes Calendar link in admin nav", () => {
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      [],
      "2026-03-10",
    );
    expect(html).toContain('href="/admin/calendar"');
  });

  test("renders empty string for attendee without email", () => {
    const attendees = [calendarAttendee({ email: "" })];
    const html = adminCalendarPage(
      attendees,
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).toContain("John Doe");
  });

  test("escapes attendee data", () => {
    const attendees = [calendarAttendee({ name: "<script>evil()</script>" })];
    const html = adminCalendarPage(
      attendees,
      "localhost",
      TEST_SESSION,
      "2026-03-15",
      [],
      "2026-03-10",
    );
    expect(html).toContain("&lt;script&gt;");
  });

  test("places Select a date between past and future dates", () => {
    const dates = [
      {
        hasBookings: true,
        label: "Sunday 8 March 2026",
        value: "2026-03-08",
      },
      {
        hasBookings: true,
        label: "Monday 9 March 2026",
        value: "2026-03-09",
      },
      {
        hasBookings: true,
        label: "Sunday 15 March 2026",
        value: "2026-03-15",
      },
      {
        hasBookings: true,
        label: "Monday 16 March 2026",
        value: "2026-03-16",
      },
    ];
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      dates,
      "2026-03-10",
    );
    const selectMatch = html.match(/<select[^>]*>([\s\S]*?)<\/select>/)!;
    const optionTexts = [...selectMatch[1]!.matchAll(/>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(optionTexts).toEqual([
      "Sunday 8 March 2026",
      "Monday 9 March 2026",
      "Select a date",
      "Sunday 15 March 2026",
      "Monday 16 March 2026",
    ]);
  });

  test("places Select a date at end when all dates are past", () => {
    const dates = [
      {
        hasBookings: true,
        label: "Sunday 8 March 2026",
        value: "2026-03-08",
      },
      {
        hasBookings: true,
        label: "Monday 9 March 2026",
        value: "2026-03-09",
      },
    ];
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      dates,
      "2026-03-10",
    );
    const selectMatch = html.match(/<select[^>]*>([\s\S]*?)<\/select>/)!;
    const optionTexts = [...selectMatch[1]!.matchAll(/>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(optionTexts).toEqual([
      "Sunday 8 March 2026",
      "Monday 9 March 2026",
      "Select a date",
    ]);
  });

  test("places Select a date at start when all dates are future", () => {
    const dates = [
      {
        hasBookings: true,
        label: "Sunday 15 March 2026",
        value: "2026-03-15",
      },
      {
        hasBookings: true,
        label: "Monday 16 March 2026",
        value: "2026-03-16",
      },
    ];
    const html = adminCalendarPage(
      [],
      "localhost",
      TEST_SESSION,
      null,
      dates,
      "2026-03-10",
    );
    const selectMatch = html.match(/<select[^>]*>([\s\S]*?)<\/select>/)!;
    const optionTexts = [...selectMatch[1]!.matchAll(/>([^<]+)</g)].map(
      (m) => m[1],
    );
    expect(optionTexts).toEqual([
      "Select a date",
      "Sunday 15 March 2026",
      "Monday 16 March 2026",
    ]);
  });
});

describe("generateCalendarCsv", () => {
  test("generates CSV header for empty attendees (no Listing Date/Location columns)", () => {
    const csv = generateCalendarCsv([]);
    expect(csv).toBe(
      "Listing,Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    );
  });

  test("omits Listing Date and Listing Location columns when all empty", () => {
    const attendees = [calendarAttendee()];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Listing,Date,Name");
    expect(lines[1]).toMatch(/^Daily Listing,2026-03-15,/);
  });

  test("shows an inclusive date range for multi-day bookings", () => {
    const attendees = [calendarAttendee({ durationDays: 3 })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    // 3-day booking starting 2026-03-15 occupies the 15th through the 17th.
    expect(lines[1]).toMatch(/^Daily Listing,2026-03-15 to 2026-03-17,/);
  });

  test("includes Listing Date column when some attendees have listing dates", () => {
    const attendees = [
      calendarAttendee({ listingDate: "2026-06-15T14:00:00.000Z" }),
    ];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Listing,Listing Date,Date,Name");
    expect(lines[1]).toContain("2026-06-15T14:00:00.000Z");
  });

  test("includes Listing Location column when some attendees have listing locations", () => {
    const attendees = [calendarAttendee({ listingLocation: "Village Hall" })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Listing,Listing Location,Date,Name");
    expect(lines[1]).toContain("Village Hall");
  });

  test("includes Date column", () => {
    const attendees = [calendarAttendee({ date: "2026-03-20" })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("2026-03-20");
  });

  test("escapes listing names with commas", () => {
    const attendees = [calendarAttendee({ listingName: "Listing, Special" })];
    const csv = generateCalendarCsv(attendees);
    expect(csv).toContain('"Listing, Special"');
  });

  test("includes standard attendee columns", () => {
    const attendees = [
      calendarAttendee({
        checked_in: true,
        created: "2024-01-15T10:30:00Z",
        payment_id: "pi_abc",
        price_paid: "2000",
        quantity: 2,
      }),
    ];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("John Doe");
    expect(lines[1]).toContain("john@example.com");
    expect(lines[1]).toContain(",2,");
    expect(lines[1]).toContain("20.00");
    expect(lines[1]).toContain("pi_abc");
    expect(lines[1]).toContain(",Yes,");
  });

  test("generates multiple rows", () => {
    const attendees = [
      calendarAttendee(),
      calendarAttendee({
        id: 2,
        listingName: "Other Listing",
        name: "Jane Smith",
      }),
    ];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Daily Listing");
    expect(lines[2]).toContain("Other Listing");
  });

  test("handles null date in calendar row", () => {
    const attendees = [calendarAttendee({ date: null })];
    const csv = generateCalendarCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toMatch(/^Daily Listing,,/);
  });
});

describe("admin nav Calendar link", () => {
  test("admin dashboard includes Calendar link in nav", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/calendar"');
    expect(html).toContain("Calendar");
  });
});
