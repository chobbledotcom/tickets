// Test fixture for the hidden-package flows: one group whose members the page
// sells as fixed bundles, plus the member listing the bundles book.
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { pageBookingTree, ticketContext } from "#test-utils/ticket-ctx.ts";

/** A hidden package ("Mystery Box") with one member ("Secret Contents") that
 *  books one ticket per bundle. Returns the page context and the booking tree
 *  the bundle-limit refusal reads. */
export const hiddenPackageWithMember = async () => {
  const group = await createHiddenPackageGroup("Mystery Box");
  const member = await createTestListing({
    groupId: group.id,
    maxAttendees: 5,
    maxQuantity: 5,
    name: "Secret Contents",
  });
  const ctx = await ticketContext([member.id], group);
  return { ctx, group, member, tree: pageBookingTree(ctx) };
};
