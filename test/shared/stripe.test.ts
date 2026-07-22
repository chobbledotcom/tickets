import "./stripe-checkout-close.test.ts";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { detectStripeKeyMode, isoFromUnixSeconds } from "#shared/stripe.ts";

describe("Stripe payment operations", () => {
  test("detects test and live secret keys", () => {
    expect(detectStripeKeyMode("sk_test_example")).toBe("test");
    expect(detectStripeKeyMode("sk_live_example")).toBe("live");
    expect(detectStripeKeyMode("rk_test_example")).toBeNull();
  });

  test("converts Unix seconds to an ISO timestamp", () => {
    expect(isoFromUnixSeconds(1)).toBe("1970-01-01T00:00:01.000Z");
    expect(isoFromUnixSeconds("1")).toBe(undefined);
  });
});
