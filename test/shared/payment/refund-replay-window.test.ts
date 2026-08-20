import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundReplayUntil } from "#payment/refund-replay-window.ts";
import { DAY_MS } from "#shared/now.ts";

describe("refund provider replay windows", () => {
  test("keeps Stripe's documented exact-key promise for 24 hours", () => {
    expect(refundReplayUntil("stripe", 500)).toBe(500 + DAY_MS);
  });

  test("gives Square no undocumented automatic replay time", () => {
    expect(refundReplayUntil("square", 500)).toBe(500);
  });

  test("refuses to invent a keyed window for SumUp", () => {
    expect(() => refundReplayUntil("sumup", 500)).toThrow(
      "SumUp refunds have no keyed replay window",
    );
  });

  test("refuses malformed times at the policy boundary", () => {
    expect(() => refundReplayUntil("stripe", -1)).toThrow(
      "Refund replay time must be a non-negative safe integer",
    );
    expect(() => refundReplayUntil("stripe", Number.MAX_VALUE)).toThrow(
      "Refund replay time must be a non-negative safe integer",
    );
  });
});
