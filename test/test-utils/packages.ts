/**
 * Shared test helpers for package groups (`is_package`) and the Stage 0
 * auto-include feature. The admin add-listings and child-edge invariant
 * assertions lived inline in both `server-group-packages` and
 * `server-package-autoinclude`; they live here once so the two suites can't
 * drift on what "rejected by the package invariant" means.
 */

import { expect } from "@std/expect";
import { getGroupPackagePrices } from "#shared/db/groups.ts";
import { getChildIds } from "#shared/db/listing-parents.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** POST the admin add-listings form to add `listingId` to `groupId`. */
export const addListingToGroup = (
  groupId: number,
  listingId: number,
): Promise<{ response: Response }> =>
  adminFormPost(`/admin/groups/${groupId}/add-listings`, {
    listing_ids: String(listingId),
  });

/** Add `listingId` to package `group` and assert it was accepted (a priced
 * member row now exists). */
export const expectPackageAddAccepted = async (
  group: { id: number },
  listingId: number,
): Promise<void> => {
  const { response } = await addListingToGroup(group.id, listingId);
  expect(response.status).toBe(302);
  const ids = (await getGroupPackagePrices(group.id)).map((r) => r.listing_id);
  expect(ids).toContain(listingId);
};

/** Add `listingId` to package `group` and assert the package invariant rejected
 * it, leaving the group with no priced members. */
export const expectPackageAddRejected = async (
  group: { id: number },
  listingId: number,
): Promise<void> => {
  const { response } = await addListingToGroup(group.id, listingId);
  await expectFlashRedirect(
    `/admin/groups/${group.id}`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  expect(await getGroupPackagePrices(group.id)).toEqual([]);
};

/** Assert a child-edge save `response` for parent `listingId` was rejected by
 * the package invariant and left the parent's edges untouched. */
export const expectPackageChildEdgeRejected = async (
  listingId: number,
  response: Response,
): Promise<void> => {
  await expectFlashRedirect(
    `/admin/listing/${listingId}/edit`,
    expect.stringContaining("Packages cannot contain"),
    false,
  )(response);
  expect(await getChildIds(listingId)).toEqual([]);
};
