import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  checkoutBookingLines,
  orderBookings,
  type SignedPaidLine,
} from "#shared/booking-lines.ts";
import type { ChildAllocation } from "#shared/db/attendee-types.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** A standard dateless listing — the default source for date/duration facts. */
const standardListing = () =>
  testListingWithCount({ listing_type: "standard" });

/** A bare signed paid line; overrides pick out the case under test. */
const line = (overrides: Partial<SignedPaidLine>): SignedPaidLine => ({
  listing: standardListing(),
  listingId: 1,
  packageGroupId: 0,
  quantity: 1,
  ...overrides,
});

/** A per-(child, parent) allocation entry. */
const alloc = (
  childId: number,
  parentId: number,
  qty: number,
): ChildAllocation => ({ childId, parentId, qty });

test("checkout booking lines name a listing that was not loaded", () => {
  expect(() =>
    checkoutBookingLines(
      [
        {
          listingId: 42,
          name: "Missing",
          quantity: 1,
          slug: "missing",
          unitPrice: 100,
        },
      ],
      new Map(),
    ),
  ).toThrow("Listing 42 was not loaded for checkout");
});

test("checkout booking lines keep the standalone package path", () => {
  const listing = standardListing();
  expect(
    checkoutBookingLines(
      [
        {
          listingId: listing.id,
          name: listing.name,
          quantity: 1,
          slug: listing.slug,
          unitPrice: 100,
        },
      ],
      new Map([[listing.id, listing]]),
    ),
  ).toMatchObject([{ packageGroupId: 0 }]);
});

describe("orderBookings > standalone and tagged package rows", () => {
  test("a standalone line books one dateless row with no parent and no token", () => {
    const result = orderBookings({
      date: null,
      lines: [line({ listingId: 7, packageGroupId: 0, quantity: 2 })],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      date: null,
      durationDays: 1,
      listingId: 7,
      packageGroupId: 0,
      quantity: 2,
    });
    // No allocations → the row is plain: no order token, no parent.
    expect(result[0]!.orderToken).toBeUndefined();
    expect(result[0]!.parentListingId).toBeUndefined();
  });

  test("a tagged package line keeps its package path", () => {
    const result = orderBookings({
      date: null,
      lines: [line({ listingId: 7, packageGroupId: 5, quantity: 1 })],
    });
    expect(result[0]).toEqual({
      date: null,
      durationDays: 1,
      listingId: 7,
      packageGroupId: 5,
      quantity: 1,
    });
  });
});

describe("orderBookings > pricePaid: 0 versus omitted", () => {
  test("a genuine 0 pricePaid is written to the row", () => {
    const result = orderBookings({
      date: null,
      lines: [line({ pricePaid: 0 })],
    });
    expect(result[0]!.pricePaid).toBe(0);
  });

  test("an omitted pricePaid stays off the row entirely", () => {
    const result = orderBookings({
      date: null,
      lines: [line({})],
    });
    expect("pricePaid" in result[0]!).toBe(false);
    expect(result[0]!.pricePaid).toBeUndefined();
  });
});

describe("orderBookings > allocations", () => {
  test("empty allocations leave the rows plain — no order token, no parent", () => {
    const result = orderBookings({
      allocations: [],
      date: null,
      lines: [line({ listingId: 7 }), line({ listingId: 8 })],
    });
    expect(result).toHaveLength(2);
    // Per-row: a mutation that silently drops one row's token keeps the
    // aggregate green, so assert each row directly.
    for (const row of result) {
      expect(row.orderToken).toBeUndefined();
      expect(row.parentListingId).toBeUndefined();
    }
  });

  test("multiple allocations expand into one row per (child, parent), sharing one order token", () => {
    // Child 20 chosen under two parents in one order: one signed line but two
    // per-parent rows, plus each parent's own row — every row carries the
    // same order token.
    const result = orderBookings({
      allocations: [alloc(20, 10, 1), alloc(20, 30, 1)],
      date: null,
      lines: [
        line({ listingId: 10, quantity: 1 }),
        line({ listingId: 30, quantity: 1 }),
        line({ listingId: 20, quantity: 2 }),
      ],
    });
    expect(result).toHaveLength(4);
    const token = result[0]!.orderToken;
    expect(token).toBeTruthy();
    for (const row of result) {
      expect(row.orderToken).toBe(token);
    }
    const childRows = result.filter((r) => r.listingId === 20);
    expect(childRows).toHaveLength(2);
    expect(childRows.some((r) => r.parentListingId === 10)).toBe(true);
    expect(childRows.some((r) => r.parentListingId === 30)).toBe(true);
    for (const row of childRows) {
      expect(row.quantity).toBe(1);
    }
  });

  test("a parent-less remainder row keeps the shared order token", () => {
    // Child 20 has qty 3 but only 1 unit allocated under a parent — the other
    // 2 were bought standalone, so the expansion keeps them as one parent-less
    // remainder row that still shares the order's token.
    const result = orderBookings({
      allocations: [alloc(20, 10, 1)],
      date: null,
      lines: [
        line({ listingId: 10, quantity: 1 }),
        line({ listingId: 20, quantity: 3 }),
      ],
    });
    const remainder = result.find(
      (r) => r.listingId === 20 && r.parentListingId === undefined,
    );
    expect(remainder).toBeDefined();
    expect(remainder!.quantity).toBe(2);
    expect(remainder!.orderToken).toBeTruthy();
  });

  test("exact paid price is conserved across the split rows", () => {
    // 100 across three single-unit allocations would lose a penny to rounding
    // under a naive per-row split; the last row must absorb the residue so
    // the order's total never drifts. orderBookings must hand the line's
    // pricePaid to the expansion unchanged.
    const result = orderBookings({
      allocations: [alloc(20, 10, 1), alloc(20, 30, 1), alloc(20, 40, 1)],
      date: null,
      lines: [
        line({ listingId: 10, quantity: 1 }),
        line({ listingId: 20, pricePaid: 100, quantity: 3 }),
      ],
    });
    const childPrices = result
      .filter((r) => r.listingId === 20)
      .map((r) => r.pricePaid ?? 0);
    expect(childPrices.reduce((total, p) => total + p, 0)).toBe(100);
    // The residual penny lands on one row, not lost to rounding.
    expect(Math.max(...childPrices)).toBe(34);
  });
});

describe("orderBookings > package stamping", () => {
  /** The package stamped onto child 20's folded row for the given parent
   *  lines (child folded under parent 10 once), so each stamping case reads
   *  only the parent paths it varies. Returns the row's `packageGroupId` as a
   *  `number` (not `number | undefined`): the builder always sets it — every
   *  row leaves `orderBookings` with a concrete `packageGroupId` (set on the
   *  raw line, preserved by `expandChildAllocations`'s spread, kept or
   *  stamped by `stampChildRowPackages`) — so the invariant is asserted here
   *  with `!` rather than modelled as a state the application says is
   *  impossible (per the repo's "Trust application invariants" rule). */
  const childPackageFor = (parentLines: SignedPaidLine[]): number =>
    orderBookings({
      allocations: [alloc(20, 10, 1)],
      date: null,
      lines: [
        ...parentLines,
        line({ listingId: 20, packageGroupId: 0, quantity: 1 }),
      ],
    }).find((r) => r.listingId === 20)!.packageGroupId!;

  test("a folded child is stamped with its parent's sole package", () => {
    expect(
      childPackageFor([
        line({ listingId: 10, packageGroupId: 7, quantity: 1 }),
      ]),
    ).toBe(7);
  });

  test("a mixed-parent path does not stamp the child", () => {
    // The parent (10) books through BOTH a package (7) and standalone (0), so
    // it has no single package path — its folded child must stay unstamped.
    expect(
      childPackageFor([
        line({ listingId: 10, packageGroupId: 7, quantity: 1 }),
        line({ listingId: 10, packageGroupId: 0, quantity: 1 }),
      ]),
    ).toBe(0);
  });

  test("a standalone-only parent does not stamp its child", () => {
    // The parent (10) books only standalone (packageGroupId 0), so there is
    // no package path to inherit — the child stays at 0.
    expect(
      childPackageFor([
        line({ listingId: 10, packageGroupId: 0, quantity: 1 }),
      ]),
    ).toBe(0);
  });
});
