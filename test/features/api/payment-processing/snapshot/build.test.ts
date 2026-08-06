import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/build.ts";
import type {
  SnapshotDayPriceRow,
  SnapshotRows,
} from "#routes/api/payment-processing/snapshot/types.ts";

const rows = (overrides: Partial<SnapshotRows> = {}): SnapshotRows => ({
  childEdges: [],
  groups: [],
  hiddenMemberIds: [],
  ledger: { hasLegs: false, ownerAttendeeId: null },
  listings: [],
  memberships: [],
  modifierScopes: [],
  modifiers: [],
  publicStatusIds: [4],
  visitCounts: [],
  ...overrides,
});

describe("paid order snapshot builder", () => {
  test("builds package display, membership, flat price, and day prices", () => {
    const dayPrices: SnapshotDayPriceRow[] = [
      { days: 2, groupId: 7, listingId: 11, unitPrice: 850 },
    ];
    const snapshot = buildPaidOrderSnapshot(
      [],
      rows({
        groups: [{ hideListings: true, id: 7, name: "Bundle" }],
        memberships: [
          { group_id: 7, listing_id: 11, package_price: 400, quantity: 2 },
          { group_id: 7, listing_id: 12, package_price: null, quantity: 1 },
        ],
      }),
      dayPrices,
    );

    expect(snapshot.notificationPackages.displays.get(7)).toEqual({
      hideListings: true,
      name: "Bundle",
    });
    expect(snapshot.notificationPackages.pricingByGroup.get(7)).toEqual({
      dayPriceMap: new Map([[11, new Map([[2, 850]])]]),
      memberIds: new Set([11, 12]),
      priceMap: new Map([[11, 400]]),
      quantityMap: new Map([
        [11, 2],
        [12, 1],
      ]),
    });
  });

  test("rebuilds referenced modifiers with visits and listing scopes", () => {
    const snapshot = buildPaidOrderSnapshot(
      [
        { i: 3, q: 2 },
        { i: 4, q: 1 },
        { i: 99, q: 1 },
      ],
      rows({
        modifierScopes: [{ listingId: 8, modifierId: 3 }],
        modifiers: [
          {
            calcKind: "fixed",
            calcValue: 5,
            direction: "discount",
            id: 3,
            minVisits: 2,
            name: "Returning buyer",
            scope: "listings",
            trigger: "automatic",
          },
          {
            calcKind: "percent",
            calcValue: 10,
            direction: "charge",
            id: 4,
            minVisits: 4,
            name: "Too soon",
            scope: "all",
            trigger: "code",
          },
        ],
        visitCounts: [1, 3],
      }),
      [],
    );

    expect(snapshot.modifierSpecs).toEqual([
      {
        id: 3,
        kind: "fixed",
        listingIds: [8],
        name: "Returning buyer",
        quantity: 2,
        trigger: "automatic",
        value: -500,
      },
    ]);
  });

  test("builds ledger, relationships, and hidden members", () => {
    const snapshot = buildPaidOrderSnapshot(
      [],
      rows({
        childEdges: [{ childId: 12, parentId: 11 }],
        hiddenMemberIds: [12],
        ledger: { hasLegs: true, ownerAttendeeId: 5 },
        publicStatusIds: [9],
      }),
      [],
    );

    expect(snapshot.ledger).toEqual({ attendeeId: 5, status: "booked" });
    expect(snapshot.childrenByParentId).toEqual(new Map([[11, [12]]]));
    expect(snapshot.parentsByChildId).toEqual(new Map([[12, [11]]]));
    expect(snapshot.hiddenPackageMemberIds).toEqual(new Set([12]));
    expect(snapshot.publicStatusId).toBe(9);
  });

  test("fails when the public status is missing", () => {
    expect(() =>
      buildPaidOrderSnapshot([], rows({ publicStatusIds: [] }), []),
    ).toThrow("No attendee status has the required is_public_default flag");
  });

  test("does not apply a returning-buyer modifier without contact history", () => {
    const snapshot = buildPaidOrderSnapshot(
      [{ i: 4, q: 1 }],
      rows({
        modifiers: [
          {
            calcKind: "percent",
            calcValue: 10,
            direction: "discount",
            id: 4,
            minVisits: 1,
            name: "Returning buyer",
            scope: "all",
            trigger: "automatic",
          },
        ],
      }),
      [],
    );

    expect(snapshot.modifierSpecs).toEqual([]);
  });

  test("builds a whole-order modifier without listing scopes", () => {
    const snapshot = buildPaidOrderSnapshot(
      [{ i: 4, q: 1 }],
      rows({
        modifiers: [
          {
            calcKind: "fixed",
            calcValue: 5,
            direction: "charge",
            id: 4,
            minVisits: 0,
            name: "Booking fee",
            scope: "all",
            trigger: "automatic",
          },
        ],
      }),
      [],
    );

    expect(snapshot.modifierSpecs).toEqual([
      {
        id: 4,
        kind: "fixed",
        listingIds: null,
        name: "Booking fee",
        quantity: 1,
        trigger: "automatic",
        value: 500,
      },
    ]);
  });

  test("builds a listing modifier with no linked listings", () => {
    const snapshot = buildPaidOrderSnapshot(
      [{ i: 5, q: 1 }],
      rows({
        modifiers: [
          {
            calcKind: "fixed",
            calcValue: 5,
            direction: "charge",
            id: 5,
            minVisits: 0,
            name: "Listing fee",
            scope: "listings",
            trigger: "automatic",
          },
        ],
      }),
      [],
    );

    expect(snapshot.modifierSpecs).toEqual([
      {
        id: 5,
        kind: "fixed",
        listingIds: [],
        name: "Listing fee",
        quantity: 1,
        trigger: "automatic",
        value: 500,
      },
    ]);
  });
});
