import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { SystemNote } from "#db/notes/types.ts";
import type {
  AttendeeListSetup,
  AttendeeListState,
  AttendeeSort,
} from "#shared/attendee-list-controls.ts";
import {
  type AttendeesListPageProps,
  adminAttendeesListPage,
} from "#templates/admin/attendees-list.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testAttendee, testListingWithCount } from "#test-utils/factories.ts";
import type { AttendeeTableRow, ListingWithCount } from "#types";

/** The browser's setup over the given listings. */
const buildSetup = (
  listings: ListingWithCount[],
): AttendeeListSetup<AttendeeSort> => ({
  basePath: "/admin/attendees",
  csvPath: "/admin/attendees/csv",
  dates: [],
  defaultSort: "newest",
  listings,
  withCheckin: false,
  withDates: false,
  withPaging: true,
  withTypes: true,
});

const buildState = (
  overrides: Partial<AttendeeListState<AttendeeSort>> = {},
): AttendeeListState<AttendeeSort> => ({
  checkin: "all",
  date: null,
  listingId: null,
  page: 0,
  sort: "newest",
  type: "all",
  ...overrides,
});

/** Build page props with sensible defaults, overridable per test */
const buildProps = (
  overrides: Partial<AttendeesListPageProps> & {
    listings?: ListingWithCount[];
  } = {},
): AttendeesListPageProps => {
  const { listings, ...rest } = overrides;
  return {
    allowedDomain: "tickets.example.com",
    hasNext: false,
    names: new Map(),
    phonePrefix: "44",
    rows: [],
    session: OWNER_SESSION,
    setup: buildSetup(
      listings ?? [testListingWithCount({ id: 1, name: "Gala Night" })],
    ),
    state: buildState(),
    systemNotes: [],
    ...rest,
  };
};

/** A table row pairing an attendee with its listing */
const row = (
  attendeeId: number,
  name: string,
  listingId: number,
  listingName: string,
): AttendeeTableRow => ({
  attendee: testAttendee({ id: attendeeId, listing_id: listingId, name }),
  listings: [{ id: listingId, name: listingName }],
});

const twoListings = (): ListingWithCount[] => [
  testListingWithCount({ id: 1, name: "Gala Night" }),
  testListingWithCount({ id: 2, name: "Quiz Evening" }),
];

describe("adminAttendeesListPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the page title, nav, and heading", () => {
    const html = adminAttendeesListPage(buildProps());
    expect(html).toContain("<title>Attendees</title>");
    expect(html).toContain('href="/admin/attendees"');
    // The create link lives in the section sub-nav as a concise "Add".
    expect(html).toContain('href="/admin/attendees/new">Add<');
    expect(html).not.toContain("<h1>Attendees</h1>");
  });

  test("renders the listing filter as a GET form when several listings exist", () => {
    const html = adminAttendeesListPage(
      buildProps({ listings: twoListings() }),
    );
    expect(html).toContain('action="/admin/attendees"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="listing"');
  });

  test("hides the listing filter when only one listing exists", () => {
    const html = adminAttendeesListPage(buildProps());
    expect(html).not.toContain('name="listing"');
  });

  test("the listing form carries the other active choices as hidden inputs", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listings: twoListings(),
        state: buildState({ sort: "oldest", type: "daily" }),
      }),
    );
    expect(html).toContain('name="type" type="hidden" value="daily"');
    expect(html).toContain('name="sort" type="hidden" value="oldest"');
  });

  test("lists attendee rows with their listing name", () => {
    // The dropdown offers "Filter Option"; the row is booked on a different
    // "Booked Listing". Asserting the latter proves the table cell renders the
    // row's own listing name rather than merely echoing the filter dropdown.
    const html = adminAttendeesListPage(
      buildProps({
        listings: [testListingWithCount({ id: 1, name: "Filter Option" })],
        rows: [row(1, "Alice", 2, "Booked Listing")],
      }),
    );
    expect(html).toContain("Alice");
    expect(html).toContain("Booked Listing");
    // The row rendered, so the empty-state message must not appear.
    expect(html).not.toContain("No attendees yet");
  });

  test("shows the empty message when there are no rows", () => {
    const html = adminAttendeesListPage(buildProps({ rows: [] }));
    expect(html).toContain("No attendees yet");
  });

  test("surfaces a red notes summary for attendees that have notes", () => {
    const noteRow: SystemNote = {
      created: "2026-06-23T10:00:00.000Z",
      entity_id: 1,
      entity_type: "attendee",
      id: 1,
      note: "needs a follow-up call",
      type: "system",
    };
    const html = adminAttendeesListPage(
      buildProps({
        names: new Map([[1, "Alice"]]),
        rows: [row(1, "Alice", 2, "Booked Listing")],
        systemNotes: [noteRow],
      }),
    );
    expect(html).toContain("1 attendee has notes");
    expect(html).toContain("needs a follow-up call");
  });

  test("offers no check-in control — the browser table is read-only", () => {
    const html = adminAttendeesListPage(
      buildProps({ rows: [row(1, "Alice", 2, "Booked Listing")] }),
    );
    expect(html).not.toContain(">Check in<");
  });

  test("keeps the rows in the order the query chose", () => {
    // Rows arrive newest-first from the query; the table's own name order
    // would flip this pair, so this pins that the page trusts the given order.
    const html = adminAttendeesListPage(
      buildProps({
        rows: [
          row(2, "Zed Newest", 1, "Gala Night"),
          row(1, "Aaron Oldest", 1, "Gala Night"),
        ],
      }),
    );
    expect(html.indexOf("Zed Newest")).toBeLessThan(
      html.indexOf("Aaron Oldest"),
    );
  });

  test("shows no date column — dates belong to a listing's own list", () => {
    const html = adminAttendeesListPage(
      buildProps({ rows: [row(1, "Alice", 2, "Booked Listing")] }),
    );
    expect(html).not.toContain(">Date<");
  });

  test("links the attendees section of the guide", () => {
    const html = adminAttendeesListPage(buildProps());
    expect(html).toContain('href="/admin/guide#attendees"');
  });

  test("renders no notes summary when no listed attendee has notes", () => {
    const html = adminAttendeesListPage(
      buildProps({ rows: [row(1, "Alice", 2, "Booked Listing")] }),
    );
    expect(html).not.toContain("have notes");
  });

  test("renders a plain CSV export link when no filters are active", () => {
    const html = adminAttendeesListPage(buildProps());
    expect(html).toContain('class="table-actions"');
    expect(html).toContain('href="/admin/attendees/csv"');
    expect(html).toContain("Export CSV");
  });

  test("the CSV export link carries the active listing and type filters", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listings: [testListingWithCount({ id: 7, name: "Festival" })],
        state: buildState({ listingId: 7, type: "daily" }),
      }),
    );
    expect(html).toContain(
      'href="/admin/attendees/csv?listing=7&amp;type=daily"',
    );
  });

  test("lists every listing in the filter, plus an All option", () => {
    const html = adminAttendeesListPage(
      buildProps({ listings: twoListings() }),
    );
    expect(html).toContain("All listings");
    expect(html).toContain("Gala Night");
    expect(html).toContain("Quiz Evening");
  });

  test("flags deactivated listings in the filter", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listings: [
          testListingWithCount({ active: false, id: 1, name: "Old Show" }),
          testListingWithCount({ active: true, id: 2, name: "Live Show" }),
        ],
      }),
    );
    expect(html).toContain("Old Show (deactivated)");
    expect(html).not.toContain("Live Show (deactivated)");
  });

  test("selects the All option when no listing filter is active", () => {
    const html = adminAttendeesListPage(
      buildProps({ listings: twoListings() }),
    );
    expect(html).toContain('selected value="">');
  });

  test("selects the active listing option when filtered", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listings: twoListings(),
        state: buildState({ listingId: 2 }),
      }),
    );
    expect(html).toContain('selected value="2"');
  });

  describe("the sort bar", () => {
    test("marks the active sort and links the other", () => {
      const newest = adminAttendeesListPage(buildProps());
      expect(newest).toContain("Sort: <strong><u>Newest first</u></strong>");
      expect(newest).toContain('href="/admin/attendees?sort=oldest"');
      const oldest = adminAttendeesListPage(
        buildProps({ state: buildState({ sort: "oldest" }) }),
      );
      expect(oldest).toContain("<strong><u>Oldest first</u></strong>");
      // Back to the default order is the bare path.
      expect(oldest).toContain('href="/admin/attendees">Newest first</a>');
    });

    test("sort links keep the listing filter and reset the page", () => {
      const html = adminAttendeesListPage(
        buildProps({
          hasNext: true,
          listings: [testListingWithCount({ id: 7, name: "Festival" })],
          state: buildState({ listingId: 7, page: 2 }),
        }),
      );
      expect(html).toContain('href="/admin/attendees?listing=7&sort=oldest"');
    });
  });

  test("omits pagination entirely on a single page", () => {
    const html = adminAttendeesListPage(
      buildProps({ hasNext: false, state: buildState({ page: 0 }) }),
    );
    expect(html).not.toContain('class="pagination"');
  });

  test("shows a Next link (only) on the first of several pages", () => {
    const html = adminAttendeesListPage(buildProps({ hasNext: true }));
    expect(html).toContain('class="pagination"');
    expect(html).toContain("Next");
    // rel="next" pins the assertion to the Next link itself.
    expect(html).toContain('href="/admin/attendees?page=1" rel="next"');
    expect(html).not.toContain("Previous");
  });

  test("shows a Previous link (only) on the last page", () => {
    const html = adminAttendeesListPage(
      buildProps({ hasNext: false, state: buildState({ page: 1 }) }),
    );
    expect(html).toContain("Previous");
    // From page 1 back to page 0 with no filter/sort drops the query entirely.
    // rel="prev" pins this to the Previous link — the bare /admin/attendees
    // path also appears in the nav.
    expect(html).toContain('href="/admin/attendees" rel="prev"');
    expect(html).not.toContain("Next");
  });

  test("preserves the listing filter and sort order in paging links", () => {
    const html = adminAttendeesListPage(
      buildProps({
        hasNext: true,
        listings: [testListingWithCount({ id: 7, name: "Festival" })],
        state: buildState({ listingId: 7, page: 2, sort: "oldest" }),
      }),
    );
    // Next → page 3, Previous → page 1, both carrying listing + sort.
    // Ampersands are HTML-escaped in the rendered href attributes.
    expect(html).toContain(
      'href="/admin/attendees?listing=7&amp;sort=oldest&amp;page=3"',
    );
    expect(html).toContain(
      'href="/admin/attendees?listing=7&amp;sort=oldest&amp;page=1"',
    );
  });

  test("numbers the current page (1-based) in the pagination", () => {
    const first = adminAttendeesListPage(buildProps({ hasNext: true }));
    expect(first).toContain("<span>Page 1</span>");
    const third = adminAttendeesListPage(
      buildProps({ hasNext: true, state: buildState({ page: 2 }) }),
    );
    expect(third).toContain("<span>Page 3</span>");
  });

  // The type-filter bar only renders when the listings span more than one
  // category, so a single-category default never exercises it.
  describe("type filter bar (multiple listing categories)", () => {
    const twoCategories = (): ListingWithCount[] => [
      testListingWithCount({ id: 7, name: "Festival" }),
      testListingWithCount({
        id: 8,
        listing_type: "daily",
        name: "Day Pass",
      }),
    ];

    test("renders the bar with the active type bold and the rest as links", () => {
      const html = adminAttendeesListPage(
        buildProps({
          listings: twoCategories(),
          state: buildState({ type: "daily" }),
        }),
      );
      expect(html).toContain('class="table-actions"');
      expect(html).toContain("<strong><u>Daily</u></strong>");
      expect(html).toContain(">Standard</a>");
      expect(html).toContain(">All</a>");
    });

    test("omits the bar entirely when only one category is present", () => {
      const html = adminAttendeesListPage(buildProps());
      expect(html).not.toContain("Showing:");
    });

    test("type links reset the listing and page filters but keep the sort", () => {
      const html = adminAttendeesListPage(
        buildProps({
          listings: twoCategories(),
          state: buildState({ listingId: 7, page: 4, sort: "oldest" }),
        }),
      );
      // Scope assertions to the filter-bar fragment: the pagination links below
      // legitimately keep the listing/page, which would otherwise mask the reset.
      const bar =
        html.match(/<div class="table-actions">Showing.*?<\/div>/s)?.[0] ?? "";
      // The bar is injected via <Raw>, so its ampersands stay unescaped.
      expect(bar).toContain('href="/admin/attendees?type=daily&sort=oldest"');
      expect(bar).not.toContain("listing=7"); // specific-listing filter dropped
      expect(bar).not.toContain("page="); // page reset to the first page
    });
  });

  describe("result count", () => {
    const rowsOfThree = (): AttendeeTableRow[] => [
      row(1, "Alice", 8, "Day Pass"),
      row(2, "Bob", 8, "Day Pass"),
      row(3, "Cleo", 8, "Day Pass"),
    ];

    test("reports the filtered result count and the type label", () => {
      const html = adminAttendeesListPage(
        buildProps({
          rows: rowsOfThree(),
          state: buildState({ type: "daily" }),
        }),
      );
      expect(html).toContain("Showing 3 attendees for");
      expect(html).toContain("<strong>Daily</strong>");
    });

    test("pluralises a single filtered result", () => {
      const html = adminAttendeesListPage(
        buildProps({
          rows: [row(1, "Alice", 8, "Day Pass")],
          state: buildState({ type: "daily" }),
        }),
      );
      expect(html).toContain("Showing 1 attendee for");
    });

    test("shows no result-count line when no type filter is active", () => {
      // A non-zero row count must still stay hidden while the type is "all".
      const html = adminAttendeesListPage(
        buildProps({ rows: rowsOfThree(), state: buildState({ type: "all" }) }),
      );
      expect(html).not.toContain("attendees for");
    });
  });
});
