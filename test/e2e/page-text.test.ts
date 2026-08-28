import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pageTextCount, pageTextIncludes } from "#e2e/page-text.ts";

describe("page text markers", () => {
  test("finds a marker the page text carries", async () => {
    const ledger = "Payment received for 2 tickets. Payment received for 1.";

    await expect(
      pageTextIncludes(ledger, "ledger", "admin.ledger.human.payment"),
    ).resolves.toBe(true);
    await expect(
      pageTextIncludes("Nothing here", "ledger", "admin.ledger.human.payment"),
    ).resolves.toBe(false);
  });

  test("counts how many times the marker appears", async () => {
    const ledger = "Refund paid to A. Refund paid to B.";

    await expect(
      pageTextCount(ledger, "ledger", "admin.ledger.human.refund_cash"),
    ).resolves.toBe(2);
    await expect(
      pageTextCount(ledger, "ledger", "admin.ledger.human.payment"),
    ).resolves.toBe(0);
  });
});
