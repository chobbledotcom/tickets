/** Removing listings from a group through the typed-name confirmation. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { getListingsByGroupId, setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { expectFlash, expectFlashError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  listingGroupIdsOf,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { groupScopedAddOn } from "#test-utils/listing-parents/helpers.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";

/** The confirmed removal post: the typed group name plus the hidden ids. */
const confirmRemoval = async (
  groupId: number,
  groupName: string,
  listingIds: number[],
): Promise<Response> => {
  const session = await getTestSession();
  return handleRequest(
    mockFormRequest(
      `/admin/groups/${groupId}/remove-listings`,
      {
        confirm_identifier: groupName,
        csrf_token: session.csrfToken,
        listing_ids: listingIds.join(","),
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
  test("the confirmation page lists the chosen members and their stakes", async () => {
    const group = await createTestGroup({ name: "Shows" });
    const listing = await createTestListing({ name: "Saturday Gig" });
    await assignListingsToGroup([listing.id], group.id);

    const html = await (
      await adminGet(
        `/admin/groups/${group.id}/remove-listings?listing_ids=${listing.id}`,
      )
    ).text();

    expect(html).toContain("Saturday Gig");
    expect(html).toContain(
      "Warning: Each listing keeps its bookings and its money.",
    );
    expect(html).toContain(`value="${listing.id}"`);
  });

  test("nothing selected sends the operator back to the group", async () => {
    const group = await createTestGroup({ name: "Empty pick" });

    const response = await adminGet(
      `/admin/groups/${group.id}/remove-listings`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/admin/groups/${group.id}`);
  });

  test("a wrong group name refuses the removal", async () => {
    const group = await createTestGroup({ name: "Shows" });
    const listing = await createTestListing({ name: "Friday Social" });
    await assignListingsToGroup([listing.id], group.id);

    const response = await confirmRemoval(group.id, "Not the name", [
      listing.id,
    ]);

    expect(response.headers.get("location")).toContain(
      `/admin/groups/${group.id}`,
    );
    expectFlash(
      response,
      "Group name does not match. Please type the exact group name to confirm removal.",
      false,
    );
    expect(await listingGroupIdsOf(listing.id)).toEqual([group.id]);
  });

  test("a refused removal lands the operator back with the reason", async () => {
    // The reachability guard's refusal covers the confirmed write's error
    // branch: the flash carries its message, and nothing is removed.
    const setup = await groupScopedAddOn();
    await listingChildren.setIds(setup.parent.id, [setup.child.id]);

    const response = await confirmRemoval(setup.group.id, setup.group.name, [
      setup.parent.id,
    ]);

    expectFlashError(response);
    expect(await listingGroupIdsOf(setup.parent.id)).toEqual([setup.group.id]);
  });

  test("removes the chosen listings once the name matches", async () => {
    const group = await createTestGroup({ name: "Shows" });
    const one = await createTestListing({ name: "One" });
    const two = await createTestListing({ name: "Two" });
    await assignListingsToGroup([one.id, two.id], group.id);

    const response = await confirmRemoval(group.id, group.name, [
      one.id,
      two.id,
    ]);

    expectFlash(response, "Listings removed from group", true);
    expect(await getListingsByGroupId(group.id)).toEqual([]);
  });

  test("removes only this group when the listing sits in two groups", async () => {
    const night = await createTestGroup({ name: "Night" });
    const day = await createTestGroup({ name: "Day" });
    const listing = await createTestListing({ name: "Shared" });
    await assignListingsToGroup([listing.id], night.id);
    await assignListingsToGroup([listing.id], day.id);

    const response = await confirmRemoval(night.id, night.name, [listing.id]);

    expectFlash(response, "Listings removed from group", true);
    expect(await listingGroupIdsOf(listing.id)).toEqual([day.id]);
  });

  test("a package member loses its quantity and price overrides on purpose", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Bundle" });
    const listing = await createTestListing({ name: "In the bundle" });
    await assignListingsToGroup([listing.id], group.id);
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 1500, quantity: 2 },
    ]);

    const response = await confirmRemoval(group.id, group.name, [listing.id]);

    expectFlash(response, "Listings removed from group", true);
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
    expect(await flatOverrideRows(listing.id, group.id)).toEqual([]);
  });

  test("the removed listing is offered by the add form again", async () => {
    const group = await createTestGroup({ name: "Shows" });
    const listing = await createTestListing({ name: "Saturday Gig" });
    await assignListingsToGroup([listing.id], group.id);

    await confirmRemoval(group.id, group.name, [listing.id]);
    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    expect(html).toContain("Saturday Gig");
    expect(html).toContain(t("groups.detail.no_listings"));
  });
});
