/**
 * The listing detail page: the date filter over its attendees, its question
 * answers, and the tightest capped group the listing sits in — which it must
 * find in a fixed number of database calls, however many groups it joins.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  filterByDate,
  filteredAttendeesHandler,
  loadGroupContext,
  loadListingQuestionData,
} from "#routes/admin/listings-view.ts";
import { groups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { listingQuestions } from "#shared/db/questions/queries.ts";
import type { Attendee, ListingWithCount } from "#shared/types.ts";
import { createQuestionWithAnswers } from "#test/shared/db/questions/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createDailyTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { getTestAuthSession, withTestSession } from "#test-utils/session.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Enough for the fixed reads, far below one read per group. */
const GROUP_CONTEXT_CALL_LIMIT = 4;

/** A listing sitting in `caps.length` groups, each capped as given. */
const listingInCappedGroups = async (
  label: string,
  caps: number[],
): Promise<ListingWithCount> => {
  const groupIds: number[] = [];
  for (const [index, maxAttendees] of caps.entries()) {
    const group = await createTestGroup({
      maxAttendees,
      name: `${label} group ${index}`,
    });
    groupIds.push(group.id);
  }
  const listing = await createTestListing({ name: `${label} listing` });
  await updateTestListing(listing.id, { groupIds });
  const reloaded = await getListingWithCount(listing.id);
  if (!reloaded) throw new Error(`Listing ${listing.id} was not created`);
  return reloaded;
};

const coldGroupContextCalls = (listing: ListingWithCount): Promise<number> => {
  groups.cache.invalidate();
  return countDatabaseCalls(GROUP_CONTEXT_CALL_LIMIT, () =>
    loadGroupContext(listing, null),
  );
};

describeWithEnv("listing detail group context", { db: true }, () => {
  test("costs the same reads for six capped groups as for one", async () => {
    const one = await listingInCappedGroups("Single", [1]);
    const six = await listingInCappedGroups("Many", [10, 9, 8, 7, 6, 5]);

    expect(await coldGroupContextCalls(six)).toBe(
      await coldGroupContextCalls(one),
    );
  });

  test("surfaces the group with the fewest spots left", async () => {
    const listing = await listingInCappedGroups("Tightest", [20, 3, 11]);

    const context = await loadGroupContext(listing, null);
    expect(context).toBeDefined();
    expect(context?.group.max_attendees).toBe(3);
    expect(context?.attendeeCount).toBe(0);
  });

  test("has no context when every group the listing joins is uncapped", async () => {
    const listing = await listingInCappedGroups("Uncapped", [0, 0]);

    expect(await loadGroupContext(listing, null)).toBeUndefined();
  });
});

describeWithEnv("listing detail attendee filtering", { db: true }, () => {
  /** Two real daily bookings, the later date first, with the daily listing the
   * earlier one books. */
  const bookedOnTwoDates = async (
    label: string,
  ): Promise<{ listing: ListingWithCount; attendees: Attendee[] }> => {
    const early = await createDailyTestAttendee(
      `${label} early`,
      `${label.toLowerCase()}-early@example.com`,
      "2026-08-01",
      { name: `${label} early listing` },
    );
    const late = await createDailyTestAttendee(
      `${label} late`,
      `${label.toLowerCase()}-late@example.com`,
      "2026-08-02",
      { name: `${label} late listing` },
    );
    const listing = await getListingWithCount(early.listing.id);
    if (!listing) throw new Error("Daily listing was not created");
    return { attendees: [late.attendee, early.attendee], listing };
  };

  test("keeps only the attendees booked for the chosen date", async () => {
    const { attendees } = await bookedOnTwoDates("Filtered");

    expect(filterByDate(attendees, "2026-08-01")).toEqual([attendees[1]]);
  });

  test("keeps every attendee when no date was chosen", async () => {
    const { attendees } = await bookedOnTwoDates("Unfiltered");

    expect(filterByDate(attendees, null)).toEqual(attendees);
  });

  test("offers the booked dates for a daily listing", async () => {
    const { attendees, listing } = await bookedOnTwoDates("Daily");
    const session = await getTestAuthSession();

    const handler = filteredAttendeesHandler(
      mockRequest(`/admin/listings/${listing.id}?date=2026-08-01`),
      (ctx) => {
        expect(ctx.dateFilter).toBe("2026-08-01");
        expect(ctx.availableDates.map((d) => d.value)).toEqual([
          "2026-08-01",
          "2026-08-02",
        ]);
        expect(ctx.filteredByDate.map((a) => a.id)).toEqual([attendees[1]?.id]);
        return new Response("ok");
      },
    );
    await handler(listing, attendees, session);
  });

  test("offers no dates for a standard listing", async () => {
    const { attendees } = await bookedOnTwoDates("Standard");
    const listing = await createTestListing({
      name: "Standard detail listing",
    });
    const session = await getTestAuthSession();

    const handler = filteredAttendeesHandler(
      mockRequest(`/admin/listings/${listing.id}?date=2026-08-01`),
      (ctx) => {
        expect(ctx.dateFilter).toBeNull();
        expect(ctx.availableDates).toEqual([]);
        expect(ctx.filteredByDate).toEqual(attendees);
        return new Response("ok");
      },
    );
    await handler(listing, attendees, session);
  });
});

describeWithEnv("listing detail question answers", { db: true }, () => {
  test("returns the listing's questions", async () => {
    const listing = await createTestListing({ name: "Asked listing" });
    const question = await createQuestionWithAnswers("Which size?", ["Large"]);
    await listingQuestions.setIds(listing.id, [question.id]);

    const data = await withTestSession(() =>
      loadListingQuestionData(listing.id, []),
    );
    expect(data?.questions.map((q) => q.id)).toEqual([question.id]);
  });

  test("returns nothing for a listing with no questions", async () => {
    const listing = await createTestListing({ name: "Unasked listing" });

    expect(
      await withTestSession(() => loadListingQuestionData(listing.id, [])),
    ).toBeUndefined();
  });
});
