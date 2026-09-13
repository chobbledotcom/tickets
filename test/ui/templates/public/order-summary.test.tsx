import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PricedLine, PricedOrder } from "#shared/checkout-pricing.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { orderSummary } from "#templates/public/order-summary.tsx";

const item = (
  overrides: Partial<CheckoutItem> & { name: string; slug: string },
): CheckoutItem => ({
  listingId: 1,
  quantity: 1,
  unitPrice: 1000,
  ...overrides,
});

const line = (i: CheckoutItem, quantity: number): PricedLine => ({
  chargedUnitAmount: i.unitPrice,
  item: i,
  quantity,
});

const order = (lines: PricedLine[]): PricedOrder => ({
  extras: [],
  fullSubtotal: 0,
  lines,
  modifierApplications: [],
  total: 0,
});

describe("order summary rows", () => {
  test("a plan quote states the months the ask buys", () => {
    // Three months per unit, three units taken: the buyer picked "9 months",
    // so the row names the plan with its month total, not "3×".
    const html = orderSummary(
      order([
        line(
          item({
            initialSiteMonths: 3,
            name: "(3 Months)",
            slug: "plan-3m",
          }),
          3,
        ),
      ]),
    );
    expect(html).toContain("(3 Months) (9 months)");
    expect(html).not.toContain("3× (3 Months)");
  });

  test("a split plan order still states one month total", () => {
    // A discount splits one ask into several charged lines; the quote rows
    // regroup to the listing, so the rows read like the selector did.
    const plan = item({
      initialSiteMonths: 1,
      name: "(1 Month)",
      slug: "plan-1m",
    });
    const html = orderSummary(order([line(plan, 1), line(plan, 2)]));
    expect(html).toContain("(1 Month) (3 months)");
  });

  test("plain ticket lines keep the ×count", () => {
    const html = orderSummary(
      order([line(item({ name: "Gala", slug: "gala" }), 2)]),
    );
    expect(html).toContain("2× Gala");
    expect(html).not.toContain("× months");
  });
});
