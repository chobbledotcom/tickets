import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { tryRefund } from "#routes/api/payment-processing/refunds.ts";

describe("tryRefund", () => {
  test("returns false without calling any provider when paymentReference is empty", async () => {
    expect(await tryRefund("")).toBe(false);
  });
});
