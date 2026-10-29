import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { NO_TAX } from "#shared/tax/types.ts";
import { pricedLine, pricedOrder } from "#test-utils/factories-pricing.ts";

describe("pricing factories", () => {
  test("defaults to an empty no-tax order", () => {
    const order = pricedOrder();
    expect(order.lines).toEqual([]);
    expect(order.extras).toEqual([]);
    expect(order.tax.policy).toEqual(NO_TAX);
    expect(order.tax.total).toBe(0);
  });

  test("assesses the tax basis from the lines' list prices", () => {
    const order = pricedOrder({ lines: [pricedLine(1, 1000, 2)] });
    expect(order.tax.total).toBe(2000);
    expect(order.tax.basis.lines).toEqual([{ gross: 2000, listingId: 1 }]);
  });

  test("keeps the listed basis when a line's charged amount is discounted", () => {
    const order = pricedOrder({ lines: [pricedLine(1, 1000, 1, 250)] });
    expect(order.lines[0]!.chargedUnitAmount).toBe(250);
    expect(order.tax.total).toBe(1000);
  });
});
