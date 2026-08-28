import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pageTextCount, pageTextIncludes } from "#e2e/page-text.ts";

describe("page text markers", () => {
  test("finds a marker the page text carries", () => {
    expect(
      pageTextIncludes(
        "Payment received for 2 tickets",
        "Payment received for",
      ),
    ).toBe(true);
    expect(pageTextIncludes("Nothing here", "Payment received for")).toBe(
      false,
    );
  });

  test("counts how many times the marker appears", () => {
    const ledger = "Refund paid to A. Refund paid to B.";
    expect(pageTextCount(ledger, "Refund paid to")).toBe(2);
    expect(pageTextCount(ledger, "Payment received for")).toBe(0);
  });
});
