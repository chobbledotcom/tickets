import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#lib/csrf.ts";
import {
  activeEventStatsSection,
  adminDashboardPage,
} from "#templates/admin/dashboard.tsx";
import {
  describeWithEnv,
  setupTestEncryptionKey,
  testAttendee,
  testEventWithCount,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminDashboardPage", () => {
  test("renders empty state when no events", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain("Events");
    expect(html).toContain("No events yet");
  });

  test("renders events table", () => {
    const events = [testEventWithCount({ attendee_count: 25 })];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("Test Event");
    expect(html).toContain("25 / 100");
    expect(html).toContain("/admin/event/1");
  });

  test("displays event name", () => {
    const events = [testEventWithCount({ name: "My Test Event" })];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("My Test Event");
    expect(html).toContain("Event Name");
  });

  test("renders add event link", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain('href="/admin/event/new"');
    expect(html).toContain("Add Event");
  });

  test("renders admin notice about April 6-12 quantity bug", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain("Note from Stef");
    expect(html).toContain("April 6th");
    expect(html).toContain("hello@chobble.com");
  });

  test("includes logout link", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).toContain("/admin/logout");
  });

  test("renders newest attendees in an open details element", () => {
    const events = [testEventWithCount({ id: 1, name: "Gala Night" })];
    const attendees = [
      testAttendee({ id: 1, event_id: 1, name: "Alice" }),
      testAttendee({ id: 2, event_id: 1, name: "Bob" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION, undefined, attendees);
    expect(html).toContain("<details open");
    expect(html).toContain("Newest 2 Attendees");
  });

  test("newest attendees section not shown when no attendees", () => {
    const html = adminDashboardPage([], TEST_SESSION, undefined, []);
    expect(html).not.toContain("Newest");
    expect(html).not.toContain("<details open");
  });

  test("newest attendees shows singular for single attendee", () => {
    const events = [testEventWithCount({ id: 1 })];
    const attendees = [testAttendee({ id: 1, event_id: 1 })];
    const html = adminDashboardPage(events, TEST_SESSION, undefined, attendees);
    expect(html).toContain("Newest 1 Attendee</summary>");
  });

  test("newest attendees shows event column", () => {
    const events = [testEventWithCount({ id: 1, name: "Workshop" })];
    const attendees = [testAttendee({ id: 1, event_id: 1 })];
    const html = adminDashboardPage(events, TEST_SESSION, undefined, attendees);
    expect(html).toContain("<th>Event</th>");
    expect(html).toContain("Workshop");
  });

  test("newest attendees not shown when all attendees have unknown event_id", () => {
    const events = [testEventWithCount({ id: 1 })];
    const attendees = [testAttendee({ id: 1, event_id: 999 })];
    const html = adminDashboardPage(events, TEST_SESSION, undefined, attendees);
    expect(html).not.toContain("Newest");
    expect(html).not.toContain("<details open");
  });

  test("newest attendees skips attendees with unknown event_id", () => {
    const events = [testEventWithCount({ id: 1, name: "Known Event" })];
    const attendees = [
      testAttendee({ id: 1, event_id: 1, name: "Valid" }),
      testAttendee({ id: 2, event_id: 999, name: "Orphan" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION, undefined, attendees);
    expect(html).toContain("Valid");
    expect(html).not.toContain("Orphan");
    expect(html).toContain("Newest 1 Attendee</summary>");
  });
});

describe("adminDashboardPage inactive events", () => {
  test("renders inactive event with reduced opacity", () => {
    const events = [testEventWithCount({ active: false, attendee_count: 5 })];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("inactive-row");
    expect(html).toContain("Inactive");
  });
});

describe("adminDashboardPage with column template filters", () => {
  test("applies date filter to created column", () => {
    const events = [testEventWithCount({ created: "2026-04-10T14:00:00Z" })];
    const html = adminDashboardPage(
      events,
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
      '{{name}}, {{created | date: "%B %Y"}}',
    );
    expect(html).toContain("April 2026");
  });

  test("renders default cell format when no filter applied", () => {
    const events = [testEventWithCount({ created: "2026-04-10T14:00:00Z" })];
    const html = adminDashboardPage(
      events,
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
      "{{name}}, {{created}}",
    );
    // Default uses toLocaleDateString — locale format, not Liquid strftime
    expect(html).toContain("2026");
    expect(html).not.toContain("April 2026");
  });
});

describe("activeEventStatsSection", () => {
  test("renders income, tickets, and attendees", () => {
    const html = activeEventStatsSection({
      income: 5000,
      tickets: 30,
      attendees: 52,
    });
    expect(html).toContain("Active Event Statistics");
    expect(html).toContain("<strong>Income:</strong>");
    expect(html).toContain("<strong>Tickets:</strong>");
    expect(html).toContain("<strong>Attendees:</strong>");
    expect(html).toContain("30");
    expect(html).toContain("52");
  });

  test("renders zero values", () => {
    const html = activeEventStatsSection({
      income: 0,
      tickets: 0,
      attendees: 0,
    });
    expect(html).toContain("<strong>Tickets:</strong> 0");
    expect(html).toContain("<strong>Attendees:</strong> 0");
  });

  test("renders as closed details element", () => {
    const html = activeEventStatsSection({
      income: 0,
      tickets: 0,
      attendees: 0,
    });
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
  });
});

describe("adminDashboardPage active event statistics", () => {
  test("shows stats section when stats provided", () => {
    const html = adminDashboardPage(
      [],
      TEST_SESSION,
      undefined,
      [],
      undefined,
      {
        income: 1000,
        tickets: 5,
        attendees: 10,
      },
    );
    expect(html).toContain("Active Event Statistics");
  });

  test("does not show stats section when stats is null", () => {
    const html = adminDashboardPage(
      [],
      TEST_SESSION,
      undefined,
      [],
      undefined,
      null,
    );
    expect(html).not.toContain("Active Event Statistics");
  });

  test("does not show stats section when stats not provided", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).not.toContain("Active Event Statistics");
  });
});

describe("adminDashboardPage multi-booking link", () => {
  test("does not show multi-booking section with zero events", () => {
    const html = adminDashboardPage([], TEST_SESSION);
    expect(html).not.toContain("Multi-booking link");
  });

  test("does not show multi-booking section with one active event", () => {
    const events = [testEventWithCount({ id: 1, slug: "ab12c" })];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).not.toContain("Multi-booking link");
  });

  test("shows multi-booking section with two active events", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c", name: "Event A" }),
      testEventWithCount({ id: 2, slug: "cd34e", name: "Event B" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("Multi-booking link");
    expect(html).toContain("Event A");
    expect(html).toContain("Event B");
  });

  test("does not count inactive events toward threshold", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c", active: true }),
      testEventWithCount({ id: 2, slug: "cd34e", active: false }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).not.toContain("Multi-booking link");
  });

  test("excludes inactive events from checkboxes", () => {
    const events = [
      testEventWithCount({
        id: 1,
        slug: "ab12c",
        name: "Active One",
        active: true,
      }),
      testEventWithCount({
        id: 2,
        slug: "cd34e",
        name: "Inactive",
        active: false,
      }),
      testEventWithCount({
        id: 3,
        slug: "ef56g",
        name: "Active Two",
        active: true,
      }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("Active One");
    expect(html).toContain("Active Two");
    expect(html).not.toContain('data-multi-booking-slug="cd34e"');
  });

  test("renders checkboxes with slug data attributes", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c" }),
      testEventWithCount({ id: 2, slug: "cd34e" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain('data-multi-booking-slug="ab12c"');
    expect(html).toContain('data-multi-booking-slug="cd34e"');
  });

  test("renders URL input with domain data attribute", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c" }),
      testEventWithCount({ id: 2, slug: "cd34e" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain('data-domain="localhost"');
    expect(html).toContain("data-multi-booking-url");
    expect(html).toContain("readonly");
    expect(html).toContain('for="multi-booking-url"');
    expect(html).toContain('id="multi-booking-url"');
  });

  test("is collapsed by default via details element", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c" }),
      testEventWithCount({ id: 2, slug: "cd34e" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
  });

  test("renders embed code inputs", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c", fields: "email" }),
      testEventWithCount({ id: 2, slug: "cd34e", fields: "email,phone" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain("data-multi-booking-embed-script");
    expect(html).toContain("data-multi-booking-embed-iframe");
    expect(html).toContain('for="multi-booking-embed-script"');
    expect(html).toContain('for="multi-booking-embed-iframe"');
    expect(html).toContain('id="multi-booking-embed-script"');
    expect(html).toContain('id="multi-booking-embed-iframe"');
  });

  test("checkboxes include data-fields attribute for embed code generation", () => {
    const events = [
      testEventWithCount({ id: 1, slug: "ab12c", fields: "email" }),
      testEventWithCount({ id: 2, slug: "cd34e", fields: "email,phone" }),
    ];
    const html = adminDashboardPage(events, TEST_SESSION);
    expect(html).toContain('data-fields="email"');
    expect(html).toContain('data-fields="email,phone"');
  });
});

describeWithEnv(
  "event images",
  { env: { STORAGE_ZONE_NAME: "testzone", STORAGE_ZONE_KEY: "testkey" } },
  () => {
    describe("adminDashboardPage with images", () => {
      test("shows thumbnail when event has image_url", () => {
        const events = [testEventWithCount({ image_url: "thumb.jpg" })];
        const html = adminDashboardPage(events, TEST_SESSION);
        expect(html).toContain("/image/thumb.jpg");
        expect(html).toContain('class="event-thumbnail"');
      });

      test("does not show thumbnail when event has no image_url", () => {
        const events = [testEventWithCount({ image_url: "" })];
        const html = adminDashboardPage(events, TEST_SESSION);
        expect(html).not.toContain('src="/image/');
      });
    });
  },
);
