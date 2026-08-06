import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { foldPaidOrderSnapshot } from "#routes/api/payment-processing/snapshot/fold.ts";
import type {
  SnapshotDayPriceRow,
  SnapshotRows,
} from "#routes/api/payment-processing/snapshot/types.ts";

const rows = (overrides: Partial<SnapshotRows> = {}): SnapshotRows => ({
  answerRows: [],
  childEdges: [],
  groups: [],
  hiddenMemberIds: [],
  ledger: { hasLegs: false, ownerAttendeeId: null },
  listings: [],
  memberships: [],
  modifierScopes: [],
  modifiers: [],
  publicStatusIds: [4],
  textQuestionIds: [],
  visitCounts: [],
  ...overrides,
});

describe("paid order snapshot fold", () => {
  test("folds package display, membership, flat price, and day prices", () => {
    const dayPrices: SnapshotDayPriceRow[] = [
      { days: 2, groupId: 7, listingId: 11, unitPrice: 850 },
    ];
    const snapshot = foldPaidOrderSnapshot(
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
    const snapshot = foldPaidOrderSnapshot(
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

    expect(snapshot.visits).toBe(3);
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

  test("folds ledger, relationships, hidden members, and question facts", () => {
    const snapshot = foldPaidOrderSnapshot(
      [],
      rows({
        answerRows: [{ answerId: 21, questionId: 20 }],
        childEdges: [{ childId: 12, parentId: 11 }],
        hiddenMemberIds: [12],
        ledger: { hasLegs: true, ownerAttendeeId: 5 },
        publicStatusIds: [9],
        textQuestionIds: [22],
      }),
      [],
    );

    expect(snapshot.ledger).toEqual({ attendeeId: 5, status: "booked" });
    expect(snapshot.childrenByParentId).toEqual(new Map([[11, [12]]]));
    expect(snapshot.parentsByChildId).toEqual(new Map([[12, [11]]]));
    expect(snapshot.hiddenPackageMemberIds).toEqual(new Set([12]));
    expect(snapshot.publicStatusId).toBe(9);
    expect(snapshot.questions.questionIdByAnswerId).toEqual(
      new Map([[21, 20]]),
    );
    expect(snapshot.questions.textQuestionIds).toEqual(new Set([22]));
  });

  test("fails when the public status is missing", () => {
    expect(() =>
      foldPaidOrderSnapshot([], rows({ publicStatusIds: [] }), []),
    ).toThrow("No attendee status has the required is_public_default flag");
  });

  test("uses zero visits when the buyer has no contact history", () => {
    expect(foldPaidOrderSnapshot([], rows(), []).visits).toBe(0);
  });

  test("folds a whole-order modifier without listing scopes", () => {
    const snapshot = foldPaidOrderSnapshot(
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

  test("folds a listing modifier with no linked listings", () => {
    const snapshot = foldPaidOrderSnapshot(
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
