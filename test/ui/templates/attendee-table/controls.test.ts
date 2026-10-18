/**
 * The shared attendee-list controls template: each control renders only for a
 * list that offers it, and every link is built on the list's own base path.
 */

import { assert, assertStringIncludes } from "@std/assert";
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
import {
  testBrowserListSetup,
  testRosterListSetup,
} from "#test-utils/attendee-list.ts";
import { testDate } from "#test-utils/dates.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const state = (
  overrides: Partial<AttendeeListState> = {},
): AttendeeListState => ({
  checkin: "all",
  date: null,
  groupId: null,
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
    assertStringIncludes(html, "data-nav-select");
    assertStringIncludes(
      html,
      'value="/admin/listing/5/attendees?date=2026-08-03"',
    );
    assertStringIncludes(html, 'href="/admin/listing/5/attendees?filter=in"');
    assertStringIncludes(html, 'href="/admin/listing/5/attendees?filter=out"');
    assertStringIncludes(
      html,
      "Sort: <strong><u>By date and name</u></strong>",
    );
    assertStringIncludes(html, 'href="/admin/listing/5/attendees?sort=newest"');
    // No listing dropdown and no type bar: one listing, one kind.
    assert(!html.includes('name="listing"'));
    assert(!html.includes("Showing:"));
  });

  test("hides the day dropdown when there are no days to offer", () => {
    const html = controlsHtml(testRosterListSetup({ dates: [] }), state());
    assert(!html.includes("data-nav-select"));
  });

  test("hides the check-in bar for a list without check-in", () => {
    const html = controlsHtml(
      testRosterListSetup({ withCheckin: false }),
      state(),
    );
    assert(!html.includes("Checked In"));
  });

  test("the check-in links keep the chosen day and sort", () => {
    const html = controlsHtml(
      testRosterListSetup(),
      state({ date: testDate("2026-08-03"), sort: "newest" }),
    );
    assertStringIncludes(
      html,
      'href="/admin/listing/5/attendees?sort=newest&filter=in&date=2026-08-03"',
    );
  });

  test("the day dropdown marks the chosen day and keeps the check-in filter", () => {
    const html = controlsHtml(
      testRosterListSetup(),
      state({ checkin: "in", date: testDate("2026-08-03") }),
    );
    assertStringIncludes(
      html,
      '<option value="/admin/listing/5/attendees?filter=in&amp;date=2026-08-03" selected>',
    );
    assertStringIncludes(
      html,
      '<option value="/admin/listing/5/attendees?filter=in">',
    );
  });

  test("a type bar appears only when the listings span more than one kind", () => {
    const oneKind = testRosterListSetup({
      listings: [testListingWithCount({ id: 1 })],
      withTypes: true,
    });
    assert(!controlsHtml(oneKind, state()).includes("Showing:"));

    const twoKinds = testRosterListSetup({
      basePath: "/admin/attendees",
      listings: [
        testListingWithCount({ id: 1 }),
        testListingWithCount({ id: 2, listing_type: "daily" }),
      ],
      withTypes: true,
    });
    const html = controlsHtml(twoKinds, state());
    assertStringIncludes(html, "Showing:");
    assertStringIncludes(html, 'href="/admin/attendees?type=daily"');
  });

  test("a group dropdown appears when the list offers groups", () => {
    const browser = testBrowserListSetup();
    const html = controlsHtml(browser, state({ groupId: 5, sort: "oldest" }));
    assertStringIncludes(html, 'name="group"');
    assertStringIncludes(html, "All groups");
    assertStringIncludes(html, "Term two");
    assertStringIncludes(html, "Weekend");
    assertStringIncludes(html, 'value="5"');
    // The other active choices ride along in the form's hidden inputs.
    assertStringIncludes(html, 'name="sort" type="hidden" value="oldest"');
  });

  test("no group dropdown when the list offers no groups", () => {
    const roster = testRosterListSetup();
    assert(!controlsHtml(roster, state()).includes('name="group"'));
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
    assertStringIncludes(
      html,
      'href="/admin/listing/5/attendees?page=2" rel="next"',
    );
    assertStringIncludes(html, 'href="/admin/listing/5/attendees" rel="prev"');
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
    assertStringIncludes(html, 'href="/admin/listing/5/export?filter=out"');
    assertStringIncludes(html, "Export CSV");
  });

  test("shows no paging for a list that is not paged", () => {
    const html = String(
      FilteredAttendeeTable({
        options: tableOptions,
        view: { setup: testRosterListSetup(), state: state() },
      }),
    );
    assert(!html.includes('class="pagination"'));
  });

  test("offers no download for a list without one", () => {
    const html = String(
      FilteredAttendeeTable({
        options: tableOptions,
        view: { setup: testRosterListSetup({ csvPath: null }), state: state() },
      }),
    );
    assert(!html.includes("Export CSV"));
  });
});
