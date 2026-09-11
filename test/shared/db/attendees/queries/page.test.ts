import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeesApi } from "#db/attendees/api.ts";
import {
  ATTENDEES_PAGE_SIZE,
  getAttendeesPage,
} from "#db/attendees/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** The distinct attendee ids on a page, in row order. */
const distinctIds = (rows: { id: number }[]): number[] => [
  ...new Set(rows.map((row) => row.id)),
];

/** One attendee holding several booking lines — paging must keep every line
 *  of an attendee together, so the dedupe inside a page matters. */
const attendeeWithSeveralLines = async (
  listingIds: number[],
): Promise<number> => {
  const made = await attendeesApi.createAttendeeAtomic({
    bookings: listingIds.map((listingId) => ({ listingId, quantity: 1 })),
    email: "multi-line@example.com",
    name: "Multi Line",
  });
  if (!made.success) throw new Error("booking setup failed");
  return made.attendees[0]!.id;
};

describeWithEnv("db > attendees > getAttendeesPage", { db: true }, () => {
  test("returns a short page whole, with no next page", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, 3);

    const page = await getAttendeesPage({
      listingIds: null,
      page: 0,
      sort: "newest",
    });

    expect(page.hasNext).toBe(false);
    expect(distinctIds(page.rows)).toHaveLength(3);
  });

  test("returns a page past the data empty, with no next page", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, 2);

    const page = await getAttendeesPage({
      listingIds: null,
      page: 1,
      sort: "newest",
    });

    expect(page.hasNext).toBe(false);
    expect(page.rows).toEqual([]);
  });

  test("one attendee past the page size reports the next page", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, ATTENDEES_PAGE_SIZE + 1);

    const page = await getAttendeesPage({
      listingIds: null,
      page: 0,
      sort: "newest",
    });

    expect(page.hasNext).toBe(true);
    expect(distinctIds(page.rows)).toHaveLength(ATTENDEES_PAGE_SIZE);
    // The extra attendee's lines are dropped whole, not just one of them.
    expect(page.rows.map((row) => row.id)).not.toContain(
      distinctIds(page.rows)[0]! - ATTENDEES_PAGE_SIZE,
    );
  });

  test("the second page holds exactly the overflow attendee", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, ATTENDEES_PAGE_SIZE + 1);

    const page = await getAttendeesPage({
      listingIds: null,
      page: 1,
      sort: "newest",
    });

    expect(page.hasNext).toBe(false);
    expect(distinctIds(page.rows)).toHaveLength(1);
  });

  test("keeps every line of an attendee inside one page", async () => {
    const listing = await createTestListing();
    const other = await createTestListing();
    const third = await createTestListing();
    await seedFillerAttendees(listing.id, ATTENDEES_PAGE_SIZE);
    // The multi-line attendee is created last, so newest-first paging keeps
    // it on page 0 together with both of its lines. It books two listings
    // with room left; the first listing is already full.
    const multiLineId = await attendeeWithSeveralLines([other.id, third.id]);

    const page = await getAttendeesPage({
      listingIds: null,
      page: 0,
      sort: "newest",
    });
    const lines = page.rows.filter((row) => row.id === multiLineId);

    expect(lines.length).toBe(2);
    expect(distinctIds(page.rows)).toHaveLength(ATTENDEES_PAGE_SIZE);
    // Every attendee's lines count in full: 99 single-line fillers plus this
    // attendee's two. A page that split (or double-counted) an attendee's
    // lines would change this row count.
    expect(page.rows.length).toBe(ATTENDEES_PAGE_SIZE + 1);
  });

  test("the first page holds the newest attendees when more than a page exists", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, ATTENDEES_PAGE_SIZE + 2);

    const page = await getAttendeesPage({
      listingIds: null,
      page: 0,
      sort: "newest",
    });
    const ids = distinctIds(page.rows).sort((a, b) => b - a);

    // More attendees than the overread: the page must come from the NEWEST
    // end, so the newest attendee id of all sits at the top of the page.
    const newestId = ids[0]!;
    expect(newestId).toBeGreaterThan(ids[1]!);
    expect(ids).not.toContain(newestId - (ATTENDEES_PAGE_SIZE + 1));
  });

  test("newest sorts attendee ids falling; oldest rising", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, 3);

    const newest = await getAttendeesPage({
      listingIds: null,
      page: 0,
      sort: "newest",
    });
    expect(distinctIds(newest.rows)).toEqual(
      [...distinctIds(newest.rows)].sort((a, b) => b - a),
    );

    const oldest = await getAttendeesPage({
      listingIds: null,
      page: 0,
      sort: "oldest",
    });
    expect(distinctIds(oldest.rows)).toEqual(
      [...distinctIds(oldest.rows)].sort((a, b) => a - b),
    );
  });

  test("filters to the given listings' attendees only", async () => {
    const listing = await createTestListing();
    const other = await createTestListing();
    await seedFillerAttendees(listing.id, 2);
    await seedFillerAttendees(other.id, 1);

    const page = await getAttendeesPage({
      listingIds: [listing.id],
      page: 0,
      sort: "newest",
    });

    expect(distinctIds(page.rows)).toHaveLength(2);
    expect(page.rows.every((row) => row.listing_id === listing.id)).toBe(true);
  });

  test("an empty listing filter matches nothing", async () => {
    const listing = await createTestListing();
    await seedFillerAttendees(listing.id, 2);

    const page = await getAttendeesPage({
      listingIds: [],
      page: 0,
      sort: "newest",
    });

    expect(page.rows).toEqual([]);
    expect(page.hasNext).toBe(false);
  });
});
