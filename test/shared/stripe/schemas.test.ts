import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  parseStripeErrorBody,
  StripeAccountSchema,
  StripeBalanceSchema,
  StripeCheckoutSessionSchema,
  StripeCreatedWebhookEndpointSchema,
  StripeDeletedWebhookEndpointSchema,
  StripeExpandedPaymentIntentSchema,
  StripeRefundSchema,
  StripeWebhookEndpointSchema,
} from "#shared/stripe/schemas.ts";
import {
  stripeCheckoutSession,
  stripePaymentIntent,
  stripeRefund,
} from "#test/lib/stripe/fixtures.ts";

const requiredFields = (value: Record<string, unknown>) =>
  Object.keys(value).map((field) => [field, value] as const);

describe("Stripe resource schemas", () => {
  for (const [resource, schema, value] of [
    ["Stripe account", StripeAccountSchema, { id: "acct_1" }],
    ["checkout", StripeCheckoutSessionSchema, stripeCheckoutSession()],
    [
      "payment intent",
      StripeExpandedPaymentIntentSchema,
      stripePaymentIntent(),
    ],
    ["refund", StripeRefundSchema, stripeRefund()],
  ] as const) {
    for (const [field, complete] of requiredFields(value)) {
      test(`rejects a ${resource} response missing ${field}`, () => {
        const response = { ...complete };
        delete response[field];
        expect(() => v.parse(schema, response)).toThrow();
      });
    }
  }

  test("rejects a latest charge missing its creation timestamp", () => {
    const intent = stripePaymentIntent();
    const charge = { ...intent.latest_charge } as Record<string, unknown>;
    delete charge.created;
    expect(() =>
      v.parse(StripeExpandedPaymentIntentSchema, {
        ...intent,
        latest_charge: charge,
      }),
    ).toThrow();
  });

  test("rejects unexpanded and malformed latest charges", () => {
    expect(() =>
      v.parse(StripeExpandedPaymentIntentSchema, {
        ...stripePaymentIntent(),
        latest_charge: "ch_unexpanded",
      }),
    ).toThrow();
    expect(() =>
      v.parse(StripeExpandedPaymentIntentSchema, {
        ...stripePaymentIntent(),
        latest_charge: {
          ...stripePaymentIntent().latest_charge,
          amount_refunded: 1_001,
        },
      }),
    ).toThrow();
  });

  test("accepts every documented non-terminal and terminal refund status", () => {
    const statuses = [
      "canceled",
      "failed",
      "pending",
      "requires_action",
      "succeeded",
    ] as const;
    expect(
      statuses.map(
        (status) =>
          v.parse(StripeRefundSchema, stripeRefund({ status })).status,
      ),
    ).toEqual(statuses);
  });

  test("rejects missing, null, and unknown refund statuses", () => {
    for (const status of [undefined, null, "complete"]) {
      expect(() =>
        v.parse(StripeRefundSchema, { ...stripeRefund(), status }),
      ).toThrow();
    }
  });

  test("requires documented Stripe ID prefixes", () => {
    expect(() =>
      v.parse(StripeCheckoutSessionSchema, {
        ...stripeCheckoutSession(),
        id: "session_1",
      }),
    ).toThrow();
    expect(() =>
      v.parse(StripeExpandedPaymentIntentSchema, {
        ...stripePaymentIntent(),
        id: "intent_1",
      }),
    ).toThrow();
    expect(() =>
      v.parse(StripeRefundSchema, { ...stripeRefund(), id: "refund_1" }),
    ).toThrow();
  });

  test("requires a boolean balance mode", () => {
    expect(() => v.parse(StripeBalanceSchema, { livemode: null })).toThrow();
  });
});

describe("Stripe supporting schemas", () => {
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

  test("rejects empty endpoint fields", () => {
    expect(() =>
      v.parse(StripeWebhookEndpointSchema, {
        enabled_events: [],
        id: "",
        status: "enabled",
        url: "https://x.test",
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
