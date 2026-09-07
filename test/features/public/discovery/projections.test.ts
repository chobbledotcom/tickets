import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";
import {
  applyBookingPageParentSoldOut,
  applyParentSoldOut,
} from "#routes/public/discovery.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const ticketListing = (id: number, active = true) =>
  buildTicketListing(
    testListingWithCount({ active, id, max_attendees: 10, max_quantity: 5 }),
    false,
    undefined,
  );

describe("parent sold-out projections", () => {
  test("sets both sold-out fields on a classified parent", () => {
    const parent = ticketListing(1);
    const [result] = applyParentSoldOut([parent], {
      addOnChildIds: new Set(),
      childIds: new Set(),
      nonStandaloneChildIds: new Set(),
      soldOutParentIds: new Set([parent.listing.id]),
    });

    expect(result!.isSoldOut).toBe(true);
    expect(result!.maxPurchasable).toBe(0);
  });

  test("requires children before the booking page marks a parent sold out", () => {
    const parent = ticketListing(1);
    const inactiveChild = ticketListing(2, false);
    const caps = {
      childOwnRemaining: new Map(),
      membership: new Map([
        [parent.listing.id, []],
        [inactiveChild.listing.id, []],
      ]),
      remainingByGroupId: new Map(),
      staticCapByGroupId: new Map(),
    };

    const [withoutChildren] = applyBookingPageParentSoldOut(
      [parent],
      new Map([[parent.listing.id, []]]),
      caps,
      [],
    );
    const [withUnavailableChild] = applyBookingPageParentSoldOut(
      [parent],
      new Map([[parent.listing.id, [inactiveChild]]]),
      caps,
      [],
    );

    expect(withoutChildren).toBe(parent);
    expect(withUnavailableChild!.isSoldOut).toBe(true);
    expect(withUnavailableChild!.maxPurchasable).toBe(0);
  });
});
