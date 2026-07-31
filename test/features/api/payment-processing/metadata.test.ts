import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { businessTime } from "#routes/api/payment-processing/metadata.ts";

describe("the time a payment counts as happening", () => {
  test("uses the time the provider says the checkout was made", () => {
    // A webhook can arrive days late; the buyer paid when they paid.
    expect(
      businessTime({
        amountTotal: 100,
        createdAt: "2026-07-01T09:00:00.000Z",
        id: "cs_1",
        paymentReference: "pi_1",
      }),
    ).toBe("2026-07-01T09:00:00.000Z");
  });
});
