import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { sumOf } from "#fp";
import { lineListPrice, listPriceOrder } from "#shared/checkout-pricing.ts";

/** One order line: its listing's list price and the quantity booked. */
const line = (id: number, unitPrice: number, quantity: number) => ({
  listing: {
    id,
    name: `Listing ${id}`,
    slug: `l${id}`,
    unit_price: unitPrice,
  },
  quantity,
});

describe("listPriceOrder", () => {
  test("prices every line at the listing's list price with a zero total", () => {
    const order = listPriceOrder([line(1, 500, 2), line(2, 1000, 1)]);
    expect(order.lines).toEqual([
      {
        chargedUnitAmount: 500,
        item: {
          listingId: 1,
          name: "Listing 1",
          quantity: 2,
          slug: "l1",
          unitPrice: 500,
        },
        quantity: 2,
      },
      {
        chargedUnitAmount: 1000,
        item: {
          listingId: 2,
          name: "Listing 2",
          quantity: 1,
          slug: "l2",
          unitPrice: 1000,
        },
        quantity: 1,
      },
    ]);
    // A list-price order carries no extras and collects nothing up front; the
    // gross is what the attendee owes.
    expect(order.extras).toEqual([]);
    expect(order.modifierApplications).toEqual([]);
    expect(order.fullSubtotal).toBe(0);
    expect(order.total).toBe(0);
    expect(sumOf(lineListPrice)(order.lines)).toBe(2000);
  });

  test("a caller's unit price override replaces the listing's own", () => {
    const order = listPriceOrder([{ ...line(1, 500, 2), unitPrice: 400 }]);
    expect(order.lines[0]).toMatchObject({
      chargedUnitAmount: 400,
      item: { unitPrice: 400 },
    });
  });

  test("an explicit zero override is a free line, not the list price", () => {
    const order = listPriceOrder([{ ...line(1, 500, 1), unitPrice: 0 }]);
    expect(order.lines[0]).toMatchObject({
      chargedUnitAmount: 0,
      item: { unitPrice: 0 },
    });
  });
});
