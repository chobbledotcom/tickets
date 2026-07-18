import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";

describe("payment refund idempotency", () => {
  test("is stable and scoped to the provider and payment", async () => {
    const stripe = await refundIdempotencyKey("stripe", "payment-1");

    expect(await refundIdempotencyKey("stripe", "payment-1")).toBe(stripe);
    expect(await refundIdempotencyKey("square", "payment-1")).not.toBe(stripe);
    expect(await refundIdempotencyKey("stripe", "payment-2")).not.toBe(stripe);
    expect(stripe).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
