import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type PricedOrder, priceCheckout } from "#shared/checkout-pricing.ts";
import {
  type CheckoutIntent,
  type CheckoutItem,
  checkoutItem,
} from "#shared/payments.ts";
import { orderSummary } from "#templates/public/order-summary.tsx";
import { testListing } from "#test-utils/factories.ts";

/** One assigned-site plan line through the production constructor. */
const planItem = (
  name: string,
  slug: string,
  initialMonths: number,
  quantity: number,
): CheckoutItem =>
  checkoutItem(
    testListing({
      assign_built_site: true,
      initial_site_months: initialMonths,
      name,
      slug,
    }),
    quantity,
    500 * initialMonths,
  );

/** Price a purchase the way the checkout pipeline does — through the real
 *  {@link priceCheckout}, so a splitting discount produces the same split
 *  lines the quote renders. */
const pricedOrder = (
  items: CheckoutItem[],
  modifiers: CheckoutIntent["modifiers"] = [],
): PricedOrder =>
  priceCheckout({
    address: "",
    date: null,
    email: "buyer@example.com",
    items,
    modifiers,
    name: "Buyer",
    phone: "",
    special_instructions: "",
  });

describe("order summary rows", () => {
  test("a plan quote states the months the ask buys", () => {
    // Three months per unit, three units taken: the buyer picked "9 months",
    // so the row names the plan with its month total, not "3×".
    const html = orderSummary(
      pricedOrder([planItem("(3 Months)", "plan-3m", 3, 3)]),
    );
    expect(html).toContain("(3 Months) (9 months)");
    expect(html).not.toContain("3× (3 Months)");
  });

  test("a renewal quote states the months its tier lines buy", () => {
    // The constructor resolves the renewal context: a two-month tier bought
    // three times states six months.
    const tier = checkoutItem(
      testListing({ months_per_unit: 2, name: "Monthly", slug: "monthly" }),
      3,
      1200,
      { renewal: true },
    );
    const html = orderSummary(pricedOrder([tier]));
    expect(html).toContain("Monthly (6 months)");
  });

  test("a split plan order still states one month total", () => {
    // A discount splits one ask into several charged lines; the quote rows
    // regroup to the listing, so the rows read like the selector did.
    const html = orderSummary(
      pricedOrder(
        [planItem("(1 Month)", "plan-1m", 1, 3)],
        [
          {
            id: 4,
            kind: "fixed",
            listingIds: null,
            name: "Penny off",
            quantity: 1,
            trigger: "code",
            value: -1,
          },
        ],
      ),
    );
    expect(html).toContain("(1 Month) (3 months)");
  });

  test("plain ticket lines keep the ×count", () => {
    const html = orderSummary(
      pricedOrder([
        {
          listingId: 2,
          name: "Gala",
          quantity: 2,
          slug: "gala",
          unitPrice: 1000,
        },
      ]),
    );
    expect(html).toContain("2× Gala");
    expect(html).not.toContain("× months");
  });
});
