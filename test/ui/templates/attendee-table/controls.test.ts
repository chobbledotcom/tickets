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
import { makeRow } from "./shared.ts";

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

  test("the group form names its select and pins the empty and chosen options", () => {
    const browser = testBrowserListSetup();
    const html = controlsHtml(browser, state({ groupId: 5, sort: "oldest" }));

    // A bare `name="group"` substring also matches the listing form's hidden
    // inputs, so match the select tag itself.
    expect(html).toMatch(/<select[^>]*name="group"/);
    expect(html).toMatch(/<option value="">All groups<\/option>/);
    expect(html).toMatch(/<option selected value="5">/);
    expect(html).toMatch(/<form[^>]*class="filter-row"/);
    expect(html).toMatch(/<form[^>]*method="get"/);
  });

  test("the listing form names its select and pins the chosen option", () => {
    const browser = testBrowserListSetup();
    const html = controlsHtml(browser, state({ listingId: 9 }));

    expect(html).toMatch(/<select[^>]*name="listing"/);
    expect(html).toMatch(/<option selected value="9">/);
  });

  test("marks the all-groups option when no group is chosen", () => {
    const browser = testBrowserListSetup();
    const html = controlsHtml(browser, state());

    expect(html).toMatch(/<option selected value="">All groups<\/option>/);
  });

  test("marks the all-listings option when no listing is chosen", () => {
    const browser = testBrowserListSetup();
    const html = controlsHtml(browser, state());

    expect(html).toMatch(/<option selected value="">All listings<\/option>/);
  });

  test("flags a deactivated listing in the listing dropdown", () => {
    const browser = testBrowserListSetup({
      listings: [
        testListingWithCount({ id: 7, name: "Open" }),
        testListingWithCount({ active: false, id: 9, name: "Closed" }),
      ],
    });
    const html = controlsHtml(browser, state());

    assertStringIncludes(html, "Closed (deactivated)");
  });

  test("drops the current page from the hidden inputs of a choice form", () => {
    const browser = testBrowserListSetup();
    const html = controlsHtml(browser, state({ groupId: 5, page: 3 }));

    expect(html).not.toMatch(/name="page"/);
  });

  test("offers the group form alone for one listing and one group", () => {
    const oneOfEach = testBrowserListSetup({
      groups: [{ id: 5, name: "Solo" }],
      listings: [testListingWithCount({ id: 7 })],
    });
    const html = controlsHtml(oneOfEach, state({ groupId: 5 }));

    expect(html).toMatch(/<select[^>]*name="group"/);
    expect(html).not.toMatch(/<select[^>]*name="listing"/);
    // The group form clears its own choice, so the chosen group id never
    // rides along as a hidden input.
    expect(html).not.toMatch(/name="group" type="hidden"/);
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
    assertStringIncludes(html, "Page 2");
  });

  test("renders a first page with its next link and page number", () => {
    const html = String(
      AttendeeListPagination({
        hasNext: true,
        view: {
          setup: testRosterListSetup({ withPaging: true }),
          state: state(),
        },
      }),
    );

    expect(html).toMatch(/<nav class="pagination"/);
    assertStringIncludes(html, "Page 1");
    assertStringIncludes(html, 'rel="next"');
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

  test("shows the result count for a filtered type and hides it for all", () => {
    const options = { ...tableOptions, rows: [makeRow()] };
    const filtered = String(
      FilteredAttendeeTable({
        options,
        view: {
          setup: testRosterListSetup(),
          state: state({ type: "standard" }),
        },
      }),
    );
    assertStringIncludes(
      filtered,
      "Showing 1 attendee for <strong>Standard</strong>",
    );

    const all = String(
      FilteredAttendeeTable({
        options,
        view: { setup: testRosterListSetup(), state: state() },
      }),
    );
    assert(!all.includes("Showing 1 attendee"));
  });
});
