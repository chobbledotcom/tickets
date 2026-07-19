import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encodeStripeForm } from "#shared/stripe/form.ts";

describe("encodeStripeForm", () => {
  test("encodes nested checkout data in Stripe bracket format", () => {
    expect(
      encodeStripeForm({
        line_items: [
          {
            price_data: {
              currency: "gbp",
              product_data: { name: "Tea & cake" },
            },
            quantity: 2,
          },
        ],
        metadata: { note: "It's fun! (*really*)" },
      }),
    ).toBe(
      "line_items[0][price_data][currency]=gbp&line_items[0][price_data][product_data][name]=Tea%20%26%20cake&line_items[0][quantity]=2&metadata[note]=It%27s%20fun%21%20%28%2Areally%2A%29",
    );
  });

  test("encodes null and skips undefined values", () => {
    expect(
      encodeStripeForm({ absent: undefined, empty: null, live: false }),
    ).toBe("empty=&live=false");
  });

  test("matches stripe-node bracket encoding inside values", () => {
    expect(encodeStripeForm({ note: "Ref[2026]" })).toBe("note=Ref[2026]");
  });
});
