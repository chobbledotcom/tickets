import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  parseStripeErrorBody,
  StripeCheckoutSessionSchema,
  StripeCreatedWebhookEndpointSchema,
  StripeDeletedWebhookEndpointSchema,
  StripeExpandedPaymentIntentSchema,
} from "#shared/stripe/schemas.ts";

const checkout = () => ({
  amount_total: 1200,
  created: 123,
  id: "cs_1",
  metadata: { booking: "signed" },
  payment_intent: "pi_1",
  payment_status: "paid",
  url: "https://checkout.stripe.com/c/pay/cs_1",
});

describe("Stripe schemas", () => {
  test("keeps only checkout fields used by the application", () => {
    expect(
      v.parse(StripeCheckoutSessionSchema, {
        ...checkout(),
        ignored: "large unused response",
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

  for (const field of Object.keys(checkout())) {
    test(`rejects a checkout response missing ${field}`, () => {
      const response: Record<string, unknown> = checkout();
      delete response[field];
      expect(() => v.parse(StripeCheckoutSessionSchema, response)).toThrow();
    });
  }

  test("rejects an unknown checkout payment status", () => {
    expect(() =>
      v.parse(StripeCheckoutSessionSchema, {
        ...checkout(),
        payment_status: "settled_some_new_way",
      }),
    ).toThrow();
  });

  test("requires the requested latest charge expansion", () => {
    expect(() =>
      v.parse(StripeExpandedPaymentIntentSchema, {
        id: "pi_1",
        latest_charge: "ch_unexpanded",
      }),
    ).toThrow();
  });

  test("requires a webhook secret from endpoint creation", () => {
    expect(() =>
      v.parse(StripeCreatedWebhookEndpointSchema, { id: "we_1" }),
    ).toThrow();
  });

  test("requires Stripe to confirm endpoint deletion", () => {
    expect(() =>
      v.parse(StripeDeletedWebhookEndpointSchema, {
        deleted: false,
        id: "we_1",
      }),
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
