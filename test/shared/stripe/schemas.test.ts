import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  parseStripeErrorBody,
  StripeBalanceSchema,
  StripeCheckoutSessionSchema,
  StripeCreatedWebhookEndpointSchema,
  StripeDeletedWebhookEndpointSchema,
  StripeExpandedPaymentIntentSchema,
  StripeRefundSchema,
  StripeWebhookEndpointListSchema,
  StripeWebhookEndpointSchema,
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

  for (const payment_status of [
    "no_payment_required",
    "paid",
    "unpaid",
  ] as const) {
    test(`accepts checkout payment status ${payment_status}`, () => {
      expect(
        v.parse(StripeCheckoutSessionSchema, {
          ...checkout(),
          payment_status,
        }).payment_status,
      ).toBe(payment_status);
    });
  }

  for (const field of ["amount_total", "metadata", "payment_intent", "url"]) {
    test(`accepts null for nullable checkout field ${field}`, () => {
      expect(
        v.parse(StripeCheckoutSessionSchema, {
          ...checkout(),
          [field]: null,
        }),
      ).toHaveProperty(field, null);
    });
  }

  for (const field of ["id", "payment_intent", "url"]) {
    test(`rejects an empty checkout ${field}`, () => {
      expect(() =>
        v.parse(StripeCheckoutSessionSchema, {
          ...checkout(),
          [field]: "",
        }),
      ).toThrow();
    });
  }

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

  for (const [schema, value] of [
    [StripeExpandedPaymentIntentSchema, { id: "", latest_charge: null }],
    [StripeRefundSchema, { id: "", status: null }],
    [StripeCreatedWebhookEndpointSchema, { id: "", secret: "secret" }],
    [StripeCreatedWebhookEndpointSchema, { id: "we_1", secret: "" }],
    [StripeDeletedWebhookEndpointSchema, { deleted: true, id: "" }],
    [
      StripeWebhookEndpointSchema,
      { enabled_events: [], id: "", status: "enabled", url: "https://x.test" },
    ],
    [
      StripeWebhookEndpointSchema,
      { enabled_events: [], id: "we_1", status: "enabled", url: "" },
    ],
  ] as const) {
    test(`rejects an empty required provider value in ${JSON.stringify(value)}`, () => {
      expect(() => v.parse(schema, value)).toThrow();
    });
  }

  test("accepts every supported refund status and null", () => {
    const statuses = [
      "canceled",
      "failed",
      "pending",
      "requires_action",
      "succeeded",
      null,
    ] as const;
    expect(
      statuses.map(
        (status) => v.parse(StripeRefundSchema, { id: "re_1", status }).status,
      ),
    ).toEqual(statuses);
  });

  test("rejects an unknown refund status", () => {
    expect(() =>
      v.parse(StripeRefundSchema, { id: "re_1", status: "complete" }),
    ).toThrow();
  });

  test("requires a boolean balance mode", () => {
    expect(() => v.parse(StripeBalanceSchema, { livemode: null })).toThrow();
  });

  test("requires Stripe to confirm endpoint deletion", () => {
    expect(() =>
      v.parse(StripeDeletedWebhookEndpointSchema, {
        deleted: false,
        id: "we_1",
      }),
    ).toThrow();
  });

  test("requires the endpoint listing to say whether more pages follow", () => {
    expect(() =>
      v.parse(StripeWebhookEndpointListSchema, { data: [] }),
    ).toThrow();
    expect(
      v.parse(StripeWebhookEndpointListSchema, { data: [], has_more: false })
        .has_more,
    ).toBe(false);
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

  test("rejects an empty Stripe error message", () => {
    expect(() =>
      parseStripeErrorBody(JSON.stringify({ error: { message: "" } })),
    ).toThrow();
  });
});
