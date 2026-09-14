import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PricedLine } from "#shared/checkout-pricing.ts";
import { countedText, orderLabel, xCount } from "#shared/count-text.ts";

/** One priced line, named as its listing would name it. */
const lineNamed = (name: string): PricedLine => ({
  chargedUnitAmount: 1000,
  item: { listingId: 1, name, quantity: 2, slug: "slug", unitPrice: 1000 },
  quantity: 2,
});

describe("count text", () => {
  test("shows a count as x and the number", () => {
    expect(xCount(1)).toBe("x1");
    expect(xCount(5)).toBe("x5");
  });

  test("wraps a thing and its count in the label every provider order shows", () => {
    expect(countedText("Tickets", 1)).toBe("Tickets (x1)");
    expect(countedText("Summer Festival", 5)).toBe("Summer Festival (x5)");
  });

  test("names the one listing an order stays on, split lines included", () => {
    expect(orderLabel([lineNamed("Summer Festival")])).toBe("Summer Festival");
    // One listing can price into several lines; the name stays one.
    expect(
      orderLabel([lineNamed("Summer Festival"), lineNamed("Summer Festival")]),
    ).toBe("Summer Festival");
  });

  test("falls back to Tickets when an order mixes listings or holds none", () => {
    expect(orderLabel([lineNamed("Workshop"), lineNamed("Gala")])).toBe(
      "Tickets",
    );
    expect(orderLabel([])).toBe("Tickets");
  });
});
