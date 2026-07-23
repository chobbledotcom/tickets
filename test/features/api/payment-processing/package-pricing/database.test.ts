import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  hasStaleStandaloneChild,
  loadPackagePricingByGroup,
  orderEdgeDrifted,
  type PackagePricing,
  type ValidatedItem,
} from "#routes/api/payment-processing/package-pricing.ts";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import type { BookingIntent, BookingItem } from "#shared/payments.ts";
import { bookingIntent } from "#test/features/api/payment-processing/index/helpers.ts";
import { listingPair } from "#test/features/api/payment-processing/items/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const loadedItem = async (item: BookingItem): Promise<ValidatedItem> => {
  const listing = await getListingWithCount(item.e);
  if (!listing) throw new Error(`Listing ${item.e} was not created`);
  return { expectedPrice: item.p, item, listing };
};

const loadedItems = (items: BookingItem[]): Promise<ValidatedItem[]> =>
  Promise.all(items.map(loadedItem));

const packagePricing = (memberIds: number[]): PackagePricing => ({
  dayPriceMap: new Map(),
  memberIds: new Set(memberIds),
  priceMap: new Map(),
  quantityMap: new Map(memberIds.map((id) => [id, 1])),
});

const edgeDrifted = async (
  items: BookingItem[],
  allocations: NonNullable<BookingIntent["allocations"]> = [],
  pricing: ReadonlyMap<number, PackagePricing> = new Map(),
): Promise<boolean> =>
  orderEdgeDrifted(
    bookingIntent(items, allocations.length > 0 ? { allocations } : {}),
    await loadedItems(items),
    pricing,
  );

const parentChildItems = (
  parentId: number,
  childId: number,
  childQuantity = 1,
): BookingItem[] => [
  { e: parentId, p: 500, q: 1 },
  { e: childId, p: 100 * childQuantity, q: childQuantity },
];

const allocatedChildEdgeDrifted = async (
  childQuantity: number,
  linked = true,
): Promise<boolean> => {
  const { child, parent } = await listingPair(
    { unitPrice: 500 },
    { bookableAlone: true, unitPrice: 100 },
    linked,
  );
  return edgeDrifted(parentChildItems(parent.id, child.id, childQuantity), [
    { childId: child.id, parentId: parent.id, qty: 1 },
  ]);
};

const packagePathDrifted = async (currentMember: boolean): Promise<boolean> => {
  const group = await createTestGroup({ isPackage: true, name: "Package" });
  const listing = await createTestListing({ maxAttendees: 5, unitPrice: 300 });
  const items: BookingItem[] = [
    { e: listing.id, k: "p", p: 300, q: 1, r: group.id },
  ];
  const members = currentMember ? [listing.id] : [];
  return edgeDrifted(items, [], new Map([[group.id, packagePricing(members)]]));
};

type ChildPath = "absent" | "adopted" | "allocated";

const staleChildFor = async (
  path: ChildPath,
  childQuantity = 1,
): Promise<boolean> => {
  const { child, parent } = await listingPair();
  const parentItem: BookingItem = { e: parent.id, p: 0, q: 1 };
  const childItem: BookingItem = { e: child.id, p: 0, q: childQuantity };
  const items = path === "absent" ? [childItem] : [parentItem, childItem];
  const allocations =
    path === "allocated"
      ? [{ childId: child.id, parentId: parent.id, qty: 1 }]
      : undefined;
  return hasStaleStandaloneChild(
    bookingIntent(items, allocations ? { allocations } : {}),
  );
};

describeWithEnv("package pricing database revalidation", { db: true }, () => {
  test("loads current prices and quantities only for active package groups", async () => {
    const pkg = await createTestGroup({
      isPackage: true,
      name: "Live package",
    });
    const member = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 500, 2: 900 },
      durationDays: 2,
      groupId: pkg.id,
      listingType: "daily",
      maxAttendees: 5,
      maximumDaysAfter: 30,
      minimumDaysBefore: 0,
      unitPrice: 500,
    });
    await setGroupPackageMembers(pkg.id, [
      {
        dayPrices: { 2: 700 },
        listingId: member.id,
        price: 400,
        quantity: 2,
      },
    ]);
    const regular = await createTestGroup({ name: "Regular group" });
    const regularMember = await createTestListing({
      groupId: regular.id,
      unitPrice: 300,
    });
    const intent = bookingIntent([
      { e: member.id, k: "p", p: 800, q: 2, r: pkg.id },
      { e: regularMember.id, k: "p", p: 300, q: 1, r: regular.id },
    ]);

    const pricing = await loadPackagePricingByGroup(intent);
    expect([...pricing.keys()]).toEqual([pkg.id]);
    expect(pricing.get(pkg.id)?.memberIds).toEqual(new Set([member.id]));
    expect(pricing.get(pkg.id)?.priceMap).toEqual(new Map([[member.id, 400]]));
    expect(pricing.get(pkg.id)?.quantityMap).toEqual(new Map([[member.id, 2]]));
    expect(pricing.get(pkg.id)?.dayPriceMap).toEqual(
      new Map([[member.id, new Map([[2, 700]])]]),
    );
  });

  test("accepts an unchanged standalone listing tree", async () => {
    const listing = await createTestListing({
      maxAttendees: 5,
      unitPrice: 500,
    });
    const items = [{ e: listing.id, p: 500, q: 1 }];

    expect(await edgeDrifted(items)).toBe(false);
  });

  test("detects a required child added after checkout", async () => {
    const { parent } = await listingPair(
      { unitPrice: 500 },
      { unitPrice: 100 },
    );
    const items = [{ e: parent.id, p: 500, q: 1 }];

    expect(await edgeDrifted(items)).toBe(true);
  });

  test("accepts a child allocation while its parent edge still exists", async () => {
    expect(await allocatedChildEdgeDrifted(1)).toBe(false);
  });

  test("keeps a standalone surplus child in the rebuilt tree", async () => {
    expect(await allocatedChildEdgeDrifted(2)).toBe(false);
  });

  test("detects a removed parent-child edge", async () => {
    expect(await allocatedChildEdgeDrifted(1, false)).toBe(true);
  });

  test("keeps an unchanged package member on its signed package path", async () => {
    expect(await packagePathDrifted(true)).toBe(false);
  });

  test("detects a signed line removed from its package", async () => {
    expect(await packagePathDrifted(false)).toBe(true);
  });
});

describeWithEnv("stale standalone child detection", { db: true }, () => {
  test("ignores listings that are not non-standalone children", async () => {
    const listing = await createTestListing({ maxAttendees: 5 });

    expect(
      await hasStaleStandaloneChild(
        bookingIntent([{ e: listing.id, p: 0, q: 1 }]),
      ),
    ).toBe(false);
  });

  test("rejects a non-standalone child bought without its parent", async () => {
    expect(await staleChildFor("absent")).toBe(true);
  });

  test("accepts a child adopted by a parent in the same order", async () => {
    expect(await staleChildFor("adopted")).toBe(false);
  });

  test("accepts an exactly allocated child", async () => {
    expect(await staleChildFor("allocated")).toBe(false);
  });

  test("rejects quantity left over after its named allocation", async () => {
    expect(await staleChildFor("allocated", 2)).toBe(true);
  });
});
