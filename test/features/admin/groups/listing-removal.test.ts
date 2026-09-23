/** Removing listings from a group from the admin page. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { getListingsByGroupId, setGroupPackageMembers } from "#db/groups.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";

const removeListings = async (
  groupId: number,
  listingIds: number[],
): Promise<Response> => {
  const session = await getTestSession();
  return handleRequest(
    mockFormRequest(
      `/admin/groups/${groupId}/remove-listings`,
      {
        csrf_token: session.csrfToken,
        listing_ids: listingIds.map(String),
      },
      session.cookie,
    ),
  );
};

const flatOverrideRows = (listingId: number, groupId: number) =>
  queryAll<{ unit_price: number }>(
    "SELECT unit_price FROM listing_prices WHERE listing_id = ? AND price_type = 'group' AND price_id = ?",
    [listingId, String(groupId)],
  );

describeWithEnv("admin group listing removal", { db: true }, () => {
  test("removes the chosen listings from the group", async () => {
    const group = await createTestGroup({ name: "Night" });
    const one = await createTestListing({ name: "One" });
    const two = await createTestListing({ name: "Two" });
    await assignListingsToGroup([one.id, two.id], group.id);

    const response = await removeListings(group.id, [one.id, two.id]);

    expectFlash(response, t("success.listings_removed_from_group"), true);
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("removes only this group when the listing sits in two groups", async () => {
    const night = await createTestGroup({ name: "Night" });
    const day = await createTestGroup({ name: "Day" });
    const listing = await createTestListing({ name: "Shared" });
    await assignListingsToGroup([listing.id], night.id);
    await assignListingsToGroup([listing.id], day.id);

    const response = await removeListings(night.id, [listing.id]);

    expectFlash(response, t("success.listings_removed_from_group"), true);
    expect(await listingGroupIdsOf(listing.id)).toEqual([day.id]);
  });

  test("a package member loses its quantity and price overrides on purpose", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Bundle" });
    const listing = await createTestListing({ name: "In the bundle" });
    await assignListingsToGroup([listing.id], group.id);
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 1500, quantity: 2 },
    ]);

    const response = await removeListings(group.id, [listing.id]);

    expectFlash(response, t("success.listings_removed_from_group"), true);
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
    expect(await flatOverrideRows(listing.id, group.id)).toEqual([]);
  });

  test("the removed listing is offered by the add form again", async () => {
    const group = await createTestGroup({ name: "Shows" });
    const listing = await createTestListing({ name: "Saturday Gig" });
    await assignListingsToGroup([listing.id], group.id);

    await removeListings(group.id, [listing.id]);
    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    // The add form offers the listing again, now that it left the group.
    expect(html).toContain("Saturday Gig");
    expect(html).toContain(t("groups.detail.no_listings"));
  });

  test("removing nothing changes nothing", async () => {
    const group = await createTestGroup({ name: "Kept" });
    const listing = await createTestListing({ name: "Member" });
    await assignListingsToGroup([listing.id], group.id);

    const response = await removeListings(group.id, []);

    expectFlash(response, t("success.listings_removed_from_group"), true);
    expect(await getListingsByGroupId(group.id)).toEqual([listing]);
  });
});
