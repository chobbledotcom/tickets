import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { providerLineCopy } from "#payment/provider-line-copy.ts";
import { checkoutItem } from "#test-utils/checkout.ts";

describe("providerLineCopy", () => {
  test("describes a plan line by the months one unit buys", () => {
    expect(
      providerLineCopy(
        checkoutItem({
          name: "Plan",
          purchaseUnit: { kind: "months", monthsPerUnit: 3 },
        }),
        2,
      ),
    ).toEqual({ description: "3 months", name: "Site plan: Plan" });
    expect(
      providerLineCopy(
        checkoutItem({
          name: "Plan",
          purchaseUnit: { kind: "months", monthsPerUnit: 1 },
        }),
        4,
      ),
    ).toEqual({ description: "1 month", name: "Site plan: Plan" });
  });

  test("describes a renewal tier by its months per unit", () => {
    expect(
      providerLineCopy(
        checkoutItem({
          name: "Monthly",
          purchaseUnit: { kind: "months", monthsPerUnit: 2 },
        }),
        6,
      ),
    ).toEqual({ description: "2 months", name: "Site plan: Monthly" });
  });

  test("keeps ticket wording for ordinary lines", () => {
    expect(providerLineCopy(checkoutItem({ name: "Gala" }), 1)).toEqual({
      description: "Tickets (x1)",
      name: "Ticket: Gala",
    });
    expect(providerLineCopy(checkoutItem({ name: "Gala" }), 3)).toEqual({
      description: "Tickets (x3)",
      name: "Ticket: Gala",
    });
  });
});
