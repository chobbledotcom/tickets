/**
 * The set-up the package tests share: a group's edit form fields, a listing
 * that belongs to a group, a sold package ticket, and the two "was this
 * allowed?" checks the invariants are read through.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { attendeesApi } from "#db/attendees/api.ts";
import { getGroupById, getGroupPackagePrices, groups } from "#db/groups.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { Group, ListingWithCount } from "#types";

// jscpd:ignore-end

/** The fields the group edit form always submits, whatever else a test adds. */
interface GroupEditFields {
  description: string;
  max_attendees: string;
  name: string;
  slug: string;
  terms_and_conditions: string;
}

/** Base fields the group edit form always submits. */
export const editFields = (name: string, slug: string): GroupEditFields => ({
  description: "",
  max_attendees: "0",
  name,
  slug,
  terms_and_conditions: "",
});

/** A listing the tests made, as its own record. */
type TestListing = Awaited<ReturnType<typeof createTestListing>>;

/** Create a listing that belongs to `group`. */
export const member = (
  group: { id: number },
  name: string,
  extra: Record<string, unknown> = {},
): Promise<TestListing> =>
  createTestListing({ groupId: group.id, name, ...extra });

/** Stamp one sold ticket against `groupId` (as a package checkout would). */
export const sellPackageTicket = async (
  listingId: number,
  groupId: number,
): Promise<string> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [{ listingId, packageGroupId: groupId, quantity: 1 }],
    email: "buyer@test.com",
    name: "Buyer",
  });
  if (!result.success) throw new Error("package booking failed");
  return result.attendees[0]!.ticket_token;
};

/** Load a listing by id (used to assert a member survives its deleted
 * package). */
export const loadListing = async (
  id: number,
): Promise<ListingWithCount | null> => {
  const m = await import("#db/listings/records.ts");
  return m.getListingWithCount(id);
};

/** A HIDDEN package, its sole member, and one sold ticket stamped with the
 * group id — the state whose deletion must un-group rather than destroy. */
export const hiddenPackageWithBooking = async (
  name: string,
  slug: string,
): Promise<{
  group: Awaited<ReturnType<typeof createTestGroup>>;
  memberListing: TestListing;
  token: string;
}> => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  await groups.table.update(group.id, { hidePackageListings: true });
  const memberListing = await member(group, `${name} Member`);
  const token = await sellPackageTicket(memberListing.id, group.id);
  return { group, memberListing, token };
};

/** POST the group edit form with is_package ticked, returning the response. */
export const postIsPackage = (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<{ response: Response }> =>
  adminFormPost(`/admin/groups/${group.id}/edit`, {
    ...editFields(group.name, group.slug),
    is_package: "1",
  });

/** Assert a group edit POST was turned away by the package invariant, and hand
 * back the group as the refused save left it. */
export const expectPackageRefused = async (
  group: { id: number },
  response: Response,
): Promise<Group> => {
  await expectFlashRedirect(
    `/admin/groups/${group.id}/edit`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  return (await getGroupById(group.id))!;
};

/** POST the edit form with is_package ticked and assert it was rejected by the
 * package invariant, leaving the flag clear. */
export const expectPackageRejected = async (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<void> => {
  const { response } = await postIsPackage(group);
  const refused = await expectPackageRefused(group, response);
  expect(refused.is_package).toBe(false);
};

/** POST the edit form with is_package ticked and assert it saved. */
export const expectPackageAccepted = async (group: {
  id: number;
  name: string;
  slug: string;
}): Promise<void> => {
  const { response } = await postIsPackage(group);
  expect(response.status).toBe(302);
  expect((await getGroupById(group.id))!.is_package).toBe(true);
};

/** POST add-listings with `listingId` to a package group and assert the package
 * invariant rejected it, leaving the group with no priced members. */
export const expectAddListingRejected = async (
  group: { id: number },
  listingId: number,
): Promise<void> => {
  const { response } = await adminFormPost(
    `/admin/groups/${group.id}/add-listings`,
    { listing_ids: String(listingId) },
  );
  await expectFlashRedirect(
    `/admin/groups/${group.id}`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  expect(await getGroupPackagePrices(group.id)).toEqual([]);
};

/** A hidden package with one member listing, returning the member. */
export const hiddenPackageMember = async (
  name: string,
): Promise<TestListing> => {
  const group = await createTestGroup({ isPackage: true, name });
  await groups.table.update(group.id, { hidePackageListings: true });
  return member(group, `${name} member`);
};
