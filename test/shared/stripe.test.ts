import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { detectStripeKeyMode } from "#shared/stripe.ts";

describe("Stripe payment operations", () => {
  test("detects test and live secret keys", () => {
    expect(detectStripeKeyMode("sk_test_example")).toBe("test");
    expect(detectStripeKeyMode("sk_live_example")).toBe("live");
    expect(detectStripeKeyMode("rk_test_example")).toBeNull();
  });
});
