import { expect } from "@std/expect";
import { queryAll } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import type { stripeApi } from "#shared/stripe.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signMeta } from "#test-utils/factories.ts";
import type { Group, ListingWithCount } from "#types";

interface PackageWithChild {
  child: ListingWithCount;
  childB: ListingWithCount;
  group: Group;
  other: ListingWithCount;
  parent: ListingWithCount;
}

interface PackageChildSessionIds {
  child: number;
  group: number;
  other: number;
  parent: number;
}

interface BookingRow {
  package_group_id: number;
  parent_listing_id: number;
  quantity: number;
}

/** Real bookings, excluding a refunded order's quantity-zero placeholder. */
export const bookingRows = (listingId: number): Promise<BookingRow[]> =>
  queryAll(
    `SELECT quantity, package_group_id, parent_listing_id FROM listing_attendees
      WHERE listing_id = ? AND quantity > 0 ORDER BY id DESC`,
    [listingId],
  );

/** Assert that one child unit was booked beneath the expected member. */
export const expectChildBookedUnder = async (
  childId: number,
  parentId: number,
): Promise<void> => {
  const childRow = (await bookingRows(childId))[0]!;
  expect(childRow.quantity).toBe(1);
  expect(Number(childRow.parent_listing_id)).toBe(parentId);
};

/** A visible package whose first member offers two child choices. */
export const packageWithChild = async (
  name: string,
  slug: string,
): Promise<PackageWithChild> => {
  const group = await createTestGroup({ isPackage: true, name, slug });
  const parent = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Parent`,
    unitPrice: 1000,
  });
  const other = await createTestListing({
    groupId: group.id,
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Other`,
    unitPrice: 500,
  });
  const child = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Addon`,
    unitPrice: 300,
  });
  const childB = await createTestListing({
    maxAttendees: 10,
    maxQuantity: 10,
    name: `${name} Addon B`,
    unitPrice: 400,
  });
  await listingChildren.setIds(parent.id, [child.id, childB.id]);
  return { child, childB, group, other, parent };
};

/** One paid package order with a child folded under its first member. */
export const packageChildSession = (
  ids: PackageChildSessionIds,
  sessionId: string,
  intentId: string,
): Awaited<ReturnType<typeof stripeApi.retrieveCheckoutSession>> =>
  ({
    amount_total: 1800,
    currency: "gbp",
    id: sessionId,
    metadata: signMeta(
      {
        allocations: JSON.stringify([
          { childId: ids.child, parentId: ids.parent, qty: 1 },
        ]),
        email: `${sessionId}@example.com`,
        items: JSON.stringify([
          { e: ids.parent, k: "p", p: 1000, q: 1, r: ids.group },
          { e: ids.other, k: "p", p: 500, q: 1, r: ids.group },
          { e: ids.child, p: 300, q: 1 },
        ]),
        name: "Kit Payer",
      },
      1800,
    ),
    payment_intent: intentId,
    payment_status: "paid",
  }) as unknown as Awaited<
    ReturnType<typeof stripeApi.retrieveCheckoutSession>
  >;

/** Cap the two add-ons at two and one units. */
export const capAddonsAtThree = async (
  childId: number,
  childBId: number,
): Promise<void> => {
  const { listingsTable } = await import("#db/listings/records.ts");
  await listingsTable.update(childId, { maxAttendees: 2, maxQuantity: 2 });
  await listingsTable.update(childBId, { maxAttendees: 1, maxQuantity: 1 });
};

/** Make every package member and child free. */
export const makePackageFree = async (
  groupId: number,
  memberIds: [number, number],
  childIds: number[],
): Promise<void> => {
  const { setGroupPackageMembers } = await import("#db/groups.ts");
  const { updateTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  for (const childId of childIds) {
    await updateTestListing(childId, { unitPrice: 0 });
  }
  await setGroupPackageMembers(groupId, [
    { listingId: memberIds[0], price: 0 },
    { listingId: memberIds[1], price: 0 },
  ]);
};
