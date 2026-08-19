import { setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { listingsTable } from "#db/listings/records.ts";
import { validateAllItems as validateSnapshotItems } from "#routes/api/payment-processing/items.ts";
import { loadPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/io.ts";
import type { BookingIntent } from "#shared/booking-intent.ts";
import { bookingIntent } from "#test/features/api/payment-processing/index/helpers.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";

export const validateAllItems = async (
  session: Parameters<typeof validateSnapshotItems>[0],
  intent: BookingIntent,
): ReturnType<typeof validateSnapshotItems> =>
  validateSnapshotItems(
    session,
    intent,
    await loadPaidOrderSnapshot(session.id, intent),
  );

export const listingPair = async (
  parentOverrides: TestListingOverrides = {},
  childOverrides: TestListingOverrides = {},
  linked = true,
): Promise<{
  child: Awaited<ReturnType<typeof createTestListing>>;
  parent: Awaited<ReturnType<typeof createTestListing>>;
}> => {
  const parent = await createTestListing({
    maxAttendees: 5,
    ...parentOverrides,
  });
  const child = await createTestListing({
    maxAttendees: 5,
    ...childOverrides,
  });
  if (linked) await listingChildren.setIds(parent.id, [child.id]);
  return { child, parent };
};

export const nonStandalonePair = async (
  parentOverrides: TestListingOverrides = {},
  childOverrides: TestListingOverrides = {},
): ReturnType<typeof listingPair> => {
  const pair = await listingPair(parentOverrides, {
    bookableAlone: true,
    ...childOverrides,
  });
  await listingsTable.update(pair.child.id, { bookableAlone: false });
  return pair;
};

export const packageParentOrder = async (
  childQuantity: number,
): Promise<{ intent: BookingIntent }> => {
  const group = await createTestGroup({
    isPackage: true,
    name: "Parent bundle",
  });
  const { child, parent } = await nonStandalonePair(
    { groupId: group.id, unitPrice: 600 },
    { unitPrice: 200 },
  );
  await setGroupPackageMembers(group.id, [
    { listingId: parent.id, price: 600 },
  ]);
  return {
    intent: bookingIntent(
      [
        { e: parent.id, k: "p", p: 600, q: 1, r: group.id },
        { e: child.id, p: 200 * childQuantity, q: childQuantity },
      ],
      { allocations: [{ childId: child.id, parentId: parent.id, qty: 1 }] },
    ),
  };
};
