import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  parseStripeErrorBody,
  StripeCheckoutSessionSchema,
} from "#shared/stripe/schemas.ts";

describe("Stripe schemas", () => {
  test("keeps only checkout fields used by the application", () => {
    expect(
      v.parse(StripeCheckoutSessionSchema, {
        amount_total: 1200,
        created: 123,
        id: "cs_1",
        ignored: "large unused response",
        metadata: { booking: "signed" },
        payment_intent: "pi_1",
        payment_status: "paid",
        url: "https://checkout.stripe.com/c/pay/cs_1",
      }),
    ).toEqual({
      amount_total: 1200,
      created: 123,
      id: "cs_1",
      metadata: { booking: "signed" },
      payment_intent: "pi_1",
      payment_status: "paid",
      url: "https://checkout.stripe.com/c/pay/cs_1",
    });
  });

  test("rejects a response missing a required field", () => {
    expect(() =>
      v.parse(StripeCheckoutSessionSchema, { id: "cs_1" }),
    ).toThrow();
  });

  test("parses structured Stripe errors", () => {
    expect(
      parseStripeErrorBody(
        JSON.stringify({
          error: {
            code: "bad_key",
            message: "Invalid key",
            type: "invalid_request_error",
          },
        }),
      ),
    ).toEqual({
      error: {
        code: "bad_key",
        message: "Invalid key",
        type: "invalid_request_error",
      },
    });
  });
});
