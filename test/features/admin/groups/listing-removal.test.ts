/** Removing listings from a group through the typed-name confirmation. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assignListingsToGroup } from "#db/groups/membership/package-writes.ts";
import { getListingsByGroupId, setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import {
  expectFlash,
  expectFlashError,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { groupOverrideRows } from "#test-utils/db-helpers/group-prices.ts";
import {
  createGroupWithListings,
  createPackageWithMember,
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
        confirmIdentifier: groupName,
        csrfToken: session.csrfToken,
        listingIds: listingIds.join(","),
      },
      session.cookie,
    ),
  );
};

describeWithEnv("admin group listing removal", { db: true }, () => {
  test("the confirmation page lists the chosen members and their stakes", async () => {
    const { group, listings } = await createGroupWithListings("Shows", [
      "Saturday Gig",
    ]);
    const listing = listings[0]!;

    const html = await (
      await adminGet(
        `/admin/groups/${group.id}/remove-listings?listingIds=${listing.id}`,
      )
    ).text();

    expectIncludesAll(html, [
      "Saturday Gig",
      "Warning: Each listing keeps its bookings and its money.",
      `value="${listing.id}"`,
    ]);
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
    const { group, listings } = await createGroupWithListings("Shows", [
      "Friday Social",
    ]);
    const listing = listings[0]!;

    const response = await confirmRemoval(group.id, "Not the name", [
      listing.id,
    ]);

    assertStringIncludes(
      response.headers.get("location") ?? "",
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
    const { group, listings } = await createGroupWithListings("Shows", [
      "One",
      "Two",
    ]);

    const response = await confirmRemoval(
      group.id,
      group.name,
      listings.map((listing) => listing.id),
    );

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
    const { group, member: listing } = await createPackageWithMember("Bundle", {
      name: "In the bundle",
    });
    await setGroupPackageMembers(group.id, [
      { listingId: listing.id, price: 1500, quantity: 2 },
    ]);

    const response = await confirmRemoval(group.id, group.name, [listing.id]);

    expectFlash(response, "Listings removed from group", true);
    expect(await listingGroupIdsOf(listing.id)).toEqual([]);
    expect(await groupOverrideRows(listing.id, group.id)).toEqual([]);
  });

  test("the removed listing is offered by the add form again", async () => {
    const { group, listings } = await createGroupWithListings("Shows", [
      "Saturday Gig",
    ]);
    const listing = listings[0]!;

    await confirmRemoval(group.id, group.name, [listing.id]);
    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    expectIncludesAll(html, ["Saturday Gig", t("groups.detail.no_listings")]);
  });
});
