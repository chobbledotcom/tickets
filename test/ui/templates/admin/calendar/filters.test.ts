import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { calendarAttendee, calendarDate, calendarHtml } from "./helpers.ts";

describe("adminCalendarPage filters", () => {
  beforeAll(setupAdminPageTest);

  const agents = [
    { assignedDeliveries: 0, id: 5, initials: "JD", name: "Jamie Doe" },
  ];

  test("links inactive agent options to the attendee list", () => {
    const html = calendarHtml({ agents });
    expect(html).toContain('href="/admin/calendar?agent=5#attendees"');
    expect(html).toContain('href="/admin/calendar?agent=none#attendees"');
  });

  test("shows the active agent as plain text", () => {
    const html = calendarHtml({ agentFilter: 5, agents });
    expect(html).toContain("<strong><u>Jamie Doe</u></strong>");
    expect(html).not.toContain('href="/admin/calendar?agent=5#attendees"');
    expect(html).toContain('href="/admin/calendar#attendees"');
    expect(html).toContain('href="/admin/calendar?agent=none#attendees"');
  });

  test("keeps the selected date when the agent changes but drops the viewed month", () => {
    const html = calendarHtml({
      agentFilter: 5,
      agents,
      dateFilter: "2026-03-15",
      viewMonth: "2026-08",
    });
    expect(html).toContain('href="/admin/calendar?date=2026-03-15#attendees"');
    expect(html).toContain(
      'href="/admin/calendar?date=2026-03-15&agent=none#attendees"',
    );
  });

  test("keeps the active agent in date, month, export and check-in links", () => {
    const html = calendarHtml({
      agentFilter: 5,
      agents,
      attendees: [calendarAttendee()],
      availableDates: [calendarDate("Sunday 16 August 2026", "2026-08-16")],
      dateFilter: "2026-03-15",
      viewMonth: "2026-08",
    });
    expect(html).toContain(
      'href="/admin/calendar?date=2026-08-16&amp;agent=5#attendees"',
    );
    expect(html).toContain(
      'href="/admin/calendar?date=2026-03-15&amp;agent=5&amp;cal=2026-07#calendar"',
    );
    expect(html).toContain(
      'href="/admin/calendar/export?date=2026-03-15&amp;agent=5"',
    );
    expect(html).toContain(
      'name="return_url" type="hidden" value="/admin/calendar?date=2026-03-15&amp;agent=5#attendees"',
    );
    expect(html).toContain('value="/admin/calendar#attendees"');
  });
});
