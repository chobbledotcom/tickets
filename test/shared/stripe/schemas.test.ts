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

const refund = () => ({
  amount: 1000,
  currency: "gbp",
  id: "re_1",
  payment_intent: "pi_1",
  status: "succeeded" as const,
});

const expandedIntent = () => ({
  id: "pi_1",
  latest_charge: {
    amount_captured: 1000,
    amount_refunded: 0,
    captured: true,
    currency: "gbp",
    paid: true,
    status: "succeeded" as const,
  },
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

  test("rejects an unknown webhook endpoint status", () => {
    expect(() =>
      v.parse(StripeWebhookEndpointSchema, {
        enabled_events: [],
        id: "we_1",
        status: "paused_some_new_way",
        url: "https://x.test",
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

  for (const field of [
    "amount_captured",
    "amount_refunded",
    "captured",
    "currency",
    "paid",
    "status",
  ]) {
    test(`requires latest charge field ${field}`, () => {
      const intent = expandedIntent();
      const latestCharge: Record<string, unknown> = intent.latest_charge;
      delete latestCharge[field];
      expect(() =>
        v.parse(StripeExpandedPaymentIntentSchema, intent),
      ).toThrow();
    });
  }

  for (const status of ["failed", "pending", "succeeded"] as const) {
    test(`accepts documented charge status ${status}`, () => {
      expect(
        v.parse(StripeExpandedPaymentIntentSchema, {
          ...expandedIntent(),
          latest_charge: { ...expandedIntent().latest_charge, status },
        }).latest_charge?.status,
      ).toBe(status);
    });
  }

  test("rejects an unknown charge status", () => {
    expect(() =>
      v.parse(StripeExpandedPaymentIntentSchema, {
        ...expandedIntent(),
        latest_charge: {
          ...expandedIntent().latest_charge,
          status: "settled_some_new_way",
        },
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
    [StripeRefundSchema, { ...refund(), id: "" }],
    [StripeCreatedWebhookEndpointSchema, { id: "", secret: "secret" }],
    [StripeCreatedWebhookEndpointSchema, { id: "we_1", secret: "" }],
    [StripeDeletedWebhookEndpointSchema, { deleted: true, id: "" }],
    [
      StripeWebhookEndpointSchema,
      {
        enabled_events: [],
        id: "",
        status: "enabled",
        url: "https://x.test",
      },
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
        (status) => v.parse(StripeRefundSchema, { ...refund(), status }).status,
      ),
    ).toEqual(statuses);
  });

  test("rejects an unknown refund status", () => {
    expect(() =>
      v.parse(StripeRefundSchema, { ...refund(), status: "complete" }),
    ).toThrow();
  });

  for (const field of [
    "amount",
    "currency",
    "id",
    "payment_intent",
    "status",
  ]) {
    test(`requires refund field ${field}`, () => {
      const answer: Record<string, unknown> = refund();
      delete answer[field];
      expect(() => v.parse(StripeRefundSchema, answer)).toThrow();
    });
  }

  // The two states Stripe reports an endpoint in. A missing one would make the
  // setup page throw on a real endpoint instead of showing whether it is live.
  test("accepts every supported webhook endpoint status", () => {
    const statuses = ["disabled", "enabled"] as const;
    expect(
      statuses.map(
        (status) =>
          v.parse(StripeWebhookEndpointSchema, {
            enabled_events: [],
            id: "we_1",
            status,
            url: "https://x.test",
          }).status,
      ),
    ).toEqual(statuses);
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
