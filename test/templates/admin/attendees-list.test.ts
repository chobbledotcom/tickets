import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
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
    const html = adminAttendeesListPage(
      buildProps({
        rows: [row(1, "Alice", 1, "Gala Night")],
      }),
    );
    expect(html).toContain("Alice");
    expect(html).toContain("Gala Night");
  });

  test("shows the empty message when there are no rows", () => {
    const html = adminAttendeesListPage(buildProps({ rows: [] }));
    expect(html).toContain("No attendees yet");
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
    expect(html).toContain('href="/admin/attendees?page=1"');
    expect(html).not.toContain("Previous");
  });

  test("shows a Previous link (only) on the last page", () => {
    const html = adminAttendeesListPage(
      buildProps({ hasNext: false, page: 1 }),
    );
    expect(html).toContain("Previous");
    // From page 1 back to page 0 with no filter/sort drops the query entirely.
    expect(html).toContain('href="/admin/attendees"');
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
});
