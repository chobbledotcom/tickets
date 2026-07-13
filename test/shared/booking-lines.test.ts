import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { orderBookings } from "#shared/booking-lines.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const listing = testListingWithCount({ id: 10, slug: "parent" });
const item = { e: listing.id, p: 100, q: 1 };

test("leaves payment amount out of an unpaid staged path", () => {
  const [booking] = orderBookings([{ item, listing }], {
    allocations: [],
    date: null,
    dayCount: undefined,
    items: [item],
  });

  expect(Object.hasOwn(booking!, "pricePaid")).toBe(false);
});

test("leaves an empty allocation list as a standalone path", () => {
  const [booking] = orderBookings([{ item, listing, pricePaid: 100 }], {
    allocations: [],
    date: null,
    dayCount: undefined,
    items: [item],
  });

  expect(booking).toEqual({
    date: null,
    durationDays: 1,
    listingId: listing.id,
    packageGroupId: undefined,
    pricePaid: 100,
    quantity: 1,
  });
});

test("expands a child allocation onto its parent path", () => {
  const childListing = testListingWithCount({ id: 20, slug: "child" });
  const child = { e: childListing.id, p: 100, q: 1 };
  const [booking] = orderBookings(
    [{ item: child, listing: childListing, pricePaid: 100 }],
    {
      allocations: [{ childId: childListing.id, parentId: listing.id, qty: 1 }],
      date: null,
      dayCount: undefined,
      items: [item, child],
    },
  );

  expect(booking?.parentListingId).toBe(listing.id);
  expect(booking?.orderToken).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
