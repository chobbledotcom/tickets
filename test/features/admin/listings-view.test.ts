/**
 * The listing detail page shows the tightest capped group a listing sits in.
 * It must find that group in a fixed number of database calls, however many
 * groups the listing belongs to.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadGroupContext } from "#routes/admin/listings-view.ts";
import { groups } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
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
    const one = await listingInCappedGroups("Single", [10]);
    const six = await listingInCappedGroups("Many", [10, 9, 8, 7, 6, 5]);

    expect(await coldGroupContextCalls(six)).toBe(
      await coldGroupContextCalls(one),
    );
  });

  test("surfaces the group with the fewest spots left", async () => {
    const listing = await listingInCappedGroups("Tightest", [20, 3, 11]);

    const context = await loadGroupContext(listing, null);
    expect(context?.group.max_attendees).toBe(3);
    expect(context?.attendeeCount).toBe(0);
  });

  test("has no context when every group the listing joins is uncapped", async () => {
    const listing = await listingInCappedGroups("Uncapped", [0, 0]);

    expect(await loadGroupContext(listing, null)).toBeUndefined();
  });
});
