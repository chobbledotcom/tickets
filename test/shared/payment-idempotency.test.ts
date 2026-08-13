import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { refundIdempotencyKey } from "#shared/payment-idempotency.ts";

describe("refundIdempotencyKey", () => {
  test("returns the same SHA-256 base64url key across repeated calls", async () => {
    // A retried webhook redelivery of the same refund must reuse one key so
    // the provider treats the second call as a duplicate, not a new refund.
    const first = await refundIdempotencyKey("stripe", "pi_test_123", 1);
    const second = await refundIdempotencyKey("stripe", "pi_test_123", 1);

    expect(first).toBe("4dTbWaPKog42IKlMoGjEdBKFRwdimMkUghDo1fj8RTg");
    expect(second).toBe(first);
    expect(first).toHaveLength(43);
  });

  test("differs for distinct payment references within one provider", async () => {
    const a = await refundIdempotencyKey("stripe", "pi_a", 1);
    const b = await refundIdempotencyKey("stripe", "pi_b", 1);

    expect(a).not.toBe(b);
  });

  test("differs across providers for the same payment reference", async () => {
    // The provider is part of the hash input so a Stripe refund and a Square
    // refund that happen to share a reference can never collapse onto the
    // same provider-side idempotency key.
    const stripe = await refundIdempotencyKey("stripe", "shared_ref", 1);
    const square = await refundIdempotencyKey("square", "shared_ref", 1);

    expect(stripe).not.toBe(square);
    expect(stripe).toBe("NBpJPsWKjwtahHlU0m8xDmhpHufgo56DK2HHnxS9vK4");
    expect(square).toBe("8Sf-TR7PpauZyJcM5pZgovL1QP7pU48G_wMkIl5RnfM");
  });

  test("keeps one key within a generation and separates later generations", async () => {
    const first = await refundIdempotencyKey("stripe", "pi_generation", 1);
    const second = await refundIdempotencyKey("stripe", "pi_generation", 2);

    expect(second).toBe(
      await refundIdempotencyKey("stripe", "pi_generation", 2),
    );
    expect(second).not.toBe(first);
  });

  for (const generation of [0, -1, 1.5, Number.NaN]) {
    test(`refuses invalid generation ${generation}`, async () => {
      await expect(
        refundIdempotencyKey("stripe", "pi_invalid_generation", generation),
      ).rejects.toThrow("positive safe integer");
    });
  }
});
