import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { SystemNote } from "#shared/db/system-notes.ts";
import type { AttendeeTableRow } from "#shared/types.ts";
import {
  type AttendeesListPageProps,
  adminAttendeesListPage,
} from "#templates/admin/attendees-list.tsx";
import {
  setupTestEncryptionKey,
  testAttendee,
  testListingWithCount,
} from "#test-utils";

const TEST_SESSION = { adminLevel: "owner" as const };

/** Build page props with sensible defaults, overridable per test */
const buildProps = (
  overrides: Partial<AttendeesListPageProps> = {},
): AttendeesListPageProps => ({
  allowedDomain: "tickets.example.com",
  categories: ["standard"],
  count: 0,
  hasNext: false,
  listingId: null,
  listings: [testListingWithCount({ id: 1, name: "Gala Night" })],
  page: 0,
  phonePrefix: "44",
  rows: [],
  session: TEST_SESSION,
  sort: "newest",
  type: "all",
  ...overrides,
});

/** A table row pairing an attendee with its listing */
const row = (
  attendeeId: number,
  name: string,
  listingId: number,
  listingName: string,
): AttendeeTableRow => ({
  attendee: testAttendee({ id: attendeeId, listing_id: listingId, name }),
  listingId,
  listingName,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("adminAttendeesListPage", () => {
  test("renders the page title, nav, and heading", () => {
    const html = adminAttendeesListPage(buildProps());
    expect(html).toContain("<title>Attendees</title>");
    expect(html).toContain('href="/admin/attendees"');
    expect(html).toContain('href="/admin/attendees/new"');
    expect(html).toContain("Add Attendee");
    expect(html).not.toContain("<h1>Attendees</h1>");
  });

  test("renders the filter/sort form as a GET form", () => {
    const html = adminAttendeesListPage(buildProps());
    expect(html).toContain('action="/admin/attendees"');
    expect(html).toContain('method="get"');
    expect(html).toContain('name="listing"');
    expect(html).toContain('name="sort"');
    expect(html).toContain("Newest first");
    expect(html).toContain("Oldest first");
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
      attendee_id: 1,
      created: "2026-06-23T10:00:00.000Z",
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
        listingId: 7,
        listings: [testListingWithCount({ id: 7, name: "Festival" })],
        type: "daily",
      }),
    );
    expect(html).toContain(
      'href="/admin/attendees/csv?listing=7&amp;type=daily"',
    );
  });

  test("lists every listing in the filter, plus an All option", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listings: [
          testListingWithCount({ id: 1, name: "Gala Night" }),
          testListingWithCount({ id: 2, name: "Quiz Evening" }),
        ],
      }),
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
        ],
      }),
    );
    expect(html).toContain("Old Show (deactivated)");
  });

  test("does not flag active listings", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listings: [
          testListingWithCount({ active: true, id: 1, name: "Live Show" }),
        ],
      }),
    );
    expect(html).toContain("Live Show");
    expect(html).not.toContain("Live Show (deactivated)");
  });

  test("selects the All option when no listing filter is active", () => {
    const html = adminAttendeesListPage(buildProps({ listingId: null }));
    expect(html).toContain('selected value="">');
  });

  test("selects the active listing option when filtered", () => {
    const html = adminAttendeesListPage(
      buildProps({
        listingId: 2,
        listings: [
          testListingWithCount({ id: 1, name: "Gala Night" }),
          testListingWithCount({ id: 2, name: "Quiz Evening" }),
        ],
      }),
    );
    expect(html).toContain('selected value="2"');
  });

  test("marks the chosen sort order as selected", () => {
    const newest = adminAttendeesListPage(buildProps({ sort: "newest" }));
    expect(newest).toContain('selected value="newest"');
    const oldest = adminAttendeesListPage(buildProps({ sort: "oldest" }));
    expect(oldest).toContain('selected value="oldest"');
  });

  test("omits pagination entirely on a single page", () => {
    const html = adminAttendeesListPage(
      buildProps({ hasNext: false, page: 0 }),
    );
    expect(html).not.toContain('class="pagination"');
  });

  test("shows a Next link (only) on the first of several pages", () => {
    const html = adminAttendeesListPage(buildProps({ hasNext: true, page: 0 }));
    expect(html).toContain('class="pagination"');
    expect(html).toContain("Next");
    // rel="next" pins the assertion to the Next link itself.
    expect(html).toContain('href="/admin/attendees?page=1" rel="next"');
    expect(html).not.toContain("Previous");
  });

  test("shows a Previous link (only) on the last page", () => {
    const html = adminAttendeesListPage(
      buildProps({ hasNext: false, page: 1 }),
    );
    expect(html).toContain("Previous");
    // From page 1 back to page 0 with no filter/sort drops the query entirely.
    // rel="prev" pins this to the Previous link — the bare /admin/attendees
    // path also appears in the nav and the filter form's action.
    expect(html).toContain('href="/admin/attendees" rel="prev"');
    expect(html).not.toContain("Next");
  });

  test("preserves the listing filter and sort order in paging links", () => {
    const html = adminAttendeesListPage(
      buildProps({
        hasNext: true,
        listingId: 7,
        listings: [testListingWithCount({ id: 7, name: "Festival" })],
        page: 2,
        sort: "oldest",
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
    const first = adminAttendeesListPage(
      buildProps({ hasNext: true, page: 0 }),
    );
    expect(first).toContain("<span>Page 1</span>");
    const third = adminAttendeesListPage(
      buildProps({ hasNext: true, page: 2 }),
    );
    expect(third).toContain("<span>Page 3</span>");
  });

  // The type-filter bar only renders when the listings span more than one
  // category, so a single-category default never exercises it.
  describe("type filter bar (multiple listing categories)", () => {
    const multiCategory = (
      overrides: Partial<AttendeesListPageProps> = {},
    ): AttendeesListPageProps =>
      buildProps({ categories: ["standard", "daily"], ...overrides });

    test("renders the bar with the active type bold and the rest as links", () => {
      const html = adminAttendeesListPage(multiCategory({ type: "daily" }));
      expect(html).toContain('class="table-actions"');
      expect(html).toContain("<strong><u>Daily</u></strong>");
      expect(html).toContain(">Standard</a>");
      expect(html).toContain(">All</a>");
    });

    test("omits the bar entirely when only one category is present", () => {
      const html = adminAttendeesListPage(
        buildProps({ categories: ["standard"] }),
      );
      expect(html).not.toContain("Showing:");
    });

    test("type links reset the listing and page filters but keep the sort", () => {
      const html = adminAttendeesListPage(
        multiCategory({
          listingId: 7,
          listings: [testListingWithCount({ id: 7, name: "Festival" })],
          page: 4,
          sort: "oldest",
          type: "all",
        }),
      );
      // Scope assertions to the filter-bar fragment: the pagination links below
      // legitimately keep the listing/page, which would otherwise mask the reset.
      const bar =
        html.match(/<div class="table-actions">.*?<\/div>/s)?.[0] ?? "";
      // The bar is injected via <Raw>, so its ampersands stay unescaped.
      expect(bar).toContain('href="/admin/attendees?type=daily&sort=oldest"');
      expect(bar).not.toContain("listing=7"); // specific-listing filter dropped
      expect(bar).not.toContain("page="); // page reset to the first page
    });
  });

  describe("result count", () => {
    test("reports the filtered result count and the type label", () => {
      const html = adminAttendeesListPage(
        buildProps({
          categories: ["standard", "daily"],
          count: 3,
          type: "daily",
        }),
      );
      expect(html).toContain("Showing 3 attendees for");
      expect(html).toContain("<strong>Daily</strong>");
    });

    test("pluralises a single filtered result", () => {
      const html = adminAttendeesListPage(
        buildProps({
          categories: ["standard", "daily"],
          count: 1,
          type: "daily",
        }),
      );
      expect(html).toContain("Showing 1 attendee for");
    });

    test("shows no result-count line when no type filter is active", () => {
      // A non-zero count must still stay hidden while the type filter is "all".
      const html = adminAttendeesListPage(
        buildProps({ count: 5, type: "all" }),
      );
      expect(html).not.toContain("attendees for");
    });
  });
});
