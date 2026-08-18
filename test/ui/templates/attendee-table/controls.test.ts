/**
 * The shared attendee-list controls template: each control renders only for a
 * list that offers it, and every link is built on the list's own base path.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type {
  AttendeeListSetup,
  AttendeeListState,
} from "#shared/attendee-list-controls.ts";
import {
  AttendeeListControls,
  AttendeeListPagination,
  FilteredAttendeeTable,
} from "#templates/attendee-table/controls.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testRosterListSetup } from "#test-utils/attendee-list.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const state = (
  overrides: Partial<AttendeeListState> = {},
): AttendeeListState => ({
  checkin: "all",
  date: null,
  listingId: null,
  page: 0,
  sort: null,
  type: "all",
  ...overrides,
});

const controlsHtml = (
  setup: AttendeeListSetup,
  choices: AttendeeListState,
): string => String(AttendeeListControls({ setup, state: choices }));

describe("the shared attendee-list controls", () => {
  beforeAll(setupAdminPageTest);

  test("a roster gets the day dropdown, check-in bar, and sort bar", () => {
    const html = controlsHtml(testRosterListSetup(), state());
    expect(html).toContain("data-nav-select");
    expect(html).toContain(
      'value="/admin/listing/5/attendees?date=2026-08-03"',
    );
    expect(html).toContain('href="/admin/listing/5/attendees?filter=in"');
    expect(html).toContain('href="/admin/listing/5/attendees?filter=out"');
    expect(html).toContain("Sort: <strong><u>By date and name</u></strong>");
    expect(html).toContain('href="/admin/listing/5/attendees?sort=newest"');
    // No listing dropdown and no type bar: one listing, one kind.
    expect(html).not.toContain('name="listing"');
    expect(html).not.toContain("Showing:");
  });

  test("hides the day dropdown when there are no days to offer", () => {
    const html = controlsHtml(testRosterListSetup({ dates: [] }), state());
    expect(html).not.toContain("data-nav-select");
  });

  test("hides the check-in bar for a list without check-in", () => {
    const html = controlsHtml(
      testRosterListSetup({ withCheckin: false }),
      state(),
    );
    expect(html).not.toContain("Checked In");
  });

  test("the check-in links keep the chosen day and sort", () => {
    const html = controlsHtml(
      testRosterListSetup(),
      state({ date: "2026-08-03", sort: "newest" }),
    );
    expect(html).toContain(
      'href="/admin/listing/5/attendees?sort=newest&filter=in&date=2026-08-03"',
    );
  });

  test("the day dropdown marks the chosen day and keeps the check-in filter", () => {
    const html = controlsHtml(
      testRosterListSetup(),
      state({ checkin: "in", date: "2026-08-03" }),
    );
    expect(html).toContain(
      '<option value="/admin/listing/5/attendees?filter=in&amp;date=2026-08-03" selected>',
    );
    expect(html).toContain(
      '<option value="/admin/listing/5/attendees?filter=in">',
    );
  });

  test("a type bar appears only when the listings span more than one kind", () => {
    const oneKind = testRosterListSetup({
      listings: [testListingWithCount({ id: 1 })],
      withTypes: true,
    });
    expect(controlsHtml(oneKind, state())).not.toContain("Showing:");

    const twoKinds = testRosterListSetup({
      basePath: "/admin/attendees",
      listings: [
        testListingWithCount({ id: 1 }),
        testListingWithCount({ id: 2, listing_type: "daily" }),
      ],
      withTypes: true,
    });
    const html = controlsHtml(twoKinds, state());
    expect(html).toContain("Showing:");
    expect(html).toContain('href="/admin/attendees?type=daily"');
  });
});

describe("the shared pagination", () => {
  beforeAll(setupAdminPageTest);

  test("renders nothing for a single page", () => {
    expect(
      AttendeeListPagination({
        hasNext: false,
        view: { setup: testRosterListSetup(), state: state() },
      }),
    ).toBeNull();
  });

  test("links the pages on the list's own base path", () => {
    const html = String(
      AttendeeListPagination({
        hasNext: true,
        view: {
          setup: testRosterListSetup({ withPaging: true }),
          state: state({ page: 1 }),
        },
      }),
    );
    expect(html).toContain(
      'href="/admin/listing/5/attendees?page=2" rel="next"',
    );
    expect(html).toContain('href="/admin/listing/5/attendees" rel="prev"');
  });
});

describe("the filtered attendee table", () => {
  beforeAll(setupAdminPageTest);

  const tableOptions = {
    allowedDomain: "tickets.example.com",
    rows: [],
    showDate: false,
    showListing: false,
  };

  test("offers the list's CSV download beneath the table", () => {
    const html = String(
      FilteredAttendeeTable({
        options: tableOptions,
        view: {
          setup: testRosterListSetup(),
          state: state({ checkin: "out" }),
        },
      }),
    );
    expect(html).toContain('href="/admin/listing/5/export?filter=out"');
    expect(html).toContain("Export CSV");
  });

  test("offers no download for a list without one", () => {
    const html = String(
      FilteredAttendeeTable({
        options: tableOptions,
        view: { setup: testRosterListSetup({ csvPath: null }), state: state() },
      }),
    );
    expect(html).not.toContain("Export CSV");
  });
});
