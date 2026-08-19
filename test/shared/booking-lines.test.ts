import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ChildAllocation } from "#db/attendee-types.ts";
import {
  bookingsForOrder,
  checkoutBookingLines,
} from "#shared/booking-lines.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const item = (
  listingId: number,
  overrides: Partial<CheckoutItem> = {},
): CheckoutItem => ({
  listingId,
  name: `Listing ${listingId}`,
  quantity: 1,
  slug: `listing-${listingId}`,
  unitPrice: 100,
  ...overrides,
});

const listing = (id: number, overrides = {}) =>
  testListingWithCount({ id, listing_type: "standard", ...overrides });

const listingMap = (...listings: ReturnType<typeof listing>[]) =>
  new Map(listings.map((entry) => [entry.id, entry]));

const allocation = (
  childId: number,
  parentId: number,
  qty: number,
): ChildAllocation => ({ childId, parentId, qty });

describe("checkoutBookingLines", () => {
  test("keeps item order, quantities, package paths, and per-path prices", () => {
    const source = listing(7);
    const packageItem = item(7, { packageGroupId: 5, quantity: 2 });
    const standaloneItem = item(7, { quantity: 3, unitPrice: 200 });

    const lines = checkoutBookingLines(
      [packageItem, standaloneItem],
      listingMap(source),
      new Map([
        [packageItem, 700],
        [standaloneItem, 1100],
      ]),
    );

    expect(lines).toEqual([
      {
        listing: source,
        listingId: 7,
        packageGroupId: 5,
        pricePaid: 700,
        quantity: 2,
      },
      {
        listing: source,
        listingId: 7,
        packageGroupId: 0,
        pricePaid: 1100,
        quantity: 3,
      },
    ]);
  });

  test("keeps a real zero paid amount", () => {
    const source = listing(7);
    const checkoutItem = item(7);
    expect(
      checkoutBookingLines(
        [checkoutItem],
        listingMap(source),
        new Map([[checkoutItem, 0]]),
      ),
    ).toEqual([
      {
        listing: source,
        listingId: 7,
        packageGroupId: 0,
        pricePaid: 0,
        quantity: 1,
      },
    ]);
  });

  test("leaves paid amounts off when the order has no paid map", () => {
    const lines = checkoutBookingLines([item(7)], listingMap(listing(7)));
    expect("pricePaid" in lines[0]!).toBe(false);
  });

  test("allows the existing zero-unit item to have no priced line", () => {
    const checkoutItem = item(7, { quantity: 0 });
    const lines = checkoutBookingLines(
      [checkoutItem],
      listingMap(listing(7)),
      new Map(),
    );
    expect(lines[0]!.quantity).toBe(0);
    expect("pricePaid" in lines[0]!).toBe(false);
  });

  test("names a listing that was not loaded", () => {
    expect(() => checkoutBookingLines([item(42)], new Map())).toThrow(
      "Listing 42 was not loaded for checkout",
    );
  });

  test("names a paid amount that was not loaded", () => {
    const checkoutItem = item(42);
    expect(() =>
      checkoutBookingLines([checkoutItem], listingMap(listing(42)), new Map()),
    ).toThrow("Paid amount for listing 42 was not loaded for checkout");
  });
});

describe("bookingsForOrder", () => {
  test("builds one dateless standalone row without parent details", () => {
    const result = bookingsForOrder(
      { date: null },
      checkoutBookingLines([item(7, { quantity: 2 })], listingMap(listing(7))),
    );
    expect(result).toEqual([
      {
        date: null,
        durationDays: 1,
        listingId: 7,
        packageGroupId: 0,
        quantity: 2,
      },
    ]);
    expect(result[0]!.orderToken).toBeUndefined();
    expect(result[0]!.parentListingId).toBeUndefined();
  });

  test("uses the order day count for a customisable daily listing", () => {
    const source = listing(7, {
      customisable_days: true,
      duration_days: 8,
      listing_type: "daily",
    });
    expect(
      bookingsForOrder(
        { date: "2026-08-01", dayCount: 3 },
        checkoutBookingLines([item(7)], listingMap(source)),
      ),
    ).toEqual([
      {
        date: "2026-08-01",
        durationDays: 3,
        listingId: 7,
        packageGroupId: 0,
        quantity: 1,
      },
    ]);
  });

  test("empty allocations leave every row without parent details", () => {
    const result = bookingsForOrder(
      { allocations: [], date: null },
      checkoutBookingLines(
        [item(7), item(8)],
        listingMap(listing(7), listing(8)),
      ),
    );
    expect(result.map((row) => row.listingId)).toEqual([7, 8]);
    for (const row of result) {
      expect(row.orderToken).toBeUndefined();
      expect(row.parentListingId).toBeUndefined();
    }
  });

  test("preserves allocation order, exact prices, and each parent package", () => {
    const parentA = item(10, { packageGroupId: 7 });
    const child = item(20, { quantity: 3 });
    const parentB = item(30, { packageGroupId: 9 });
    const plain = item(40, { quantity: 2 });
    const items = [parentA, child, parentB, plain];
    const result = bookingsForOrder(
      {
        allocations: [allocation(20, 30, 1), allocation(20, 10, 1)],
        date: null,
      },
      checkoutBookingLines(
        items,
        listingMap(listing(10), listing(20), listing(30), listing(40)),
        new Map([
          [parentA, 700],
          [child, 100],
          [parentB, 900],
          [plain, 400],
        ]),
      ),
    );

    const orderToken = result[0]!.orderToken;
    expect(orderToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.map(({ orderToken: _, ...row }) => row)).toEqual([
      {
        date: null,
        durationDays: 1,
        listingId: 10,
        packageGroupId: 7,
        pricePaid: 700,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        listingId: 20,
        packageGroupId: 9,
        parentListingId: 30,
        pricePaid: 33,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        listingId: 20,
        packageGroupId: 7,
        parentListingId: 10,
        pricePaid: 33,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        listingId: 20,
        packageGroupId: 0,
        pricePaid: 34,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        listingId: 30,
        packageGroupId: 9,
        pricePaid: 900,
        quantity: 1,
      },
      {
        date: null,
        durationDays: 1,
        listingId: 40,
        packageGroupId: 0,
        pricePaid: 400,
        quantity: 2,
      },
    ]);
    for (const row of result) expect(row.orderToken).toBe(orderToken);
  });

  test("does not stamp a child when its parent has mixed paths", () => {
    const packageParent = item(10, { packageGroupId: 7 });
    const standaloneParent = item(10);
    const child = item(20);
    const result = bookingsForOrder(
      {
        allocations: [allocation(20, 10, 1)],
        date: null,
      },
      checkoutBookingLines(
        [packageParent, standaloneParent, child],
        listingMap(listing(10), listing(20)),
      ),
    );
    expect(result[2]!.listingId).toBe(20);
    expect(result[2]!.packageGroupId).toBe(0);
    expect(result[2]!.parentListingId).toBe(10);
  });
});
