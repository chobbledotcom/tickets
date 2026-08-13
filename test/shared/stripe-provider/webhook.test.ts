import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { stripeCheckoutSession } from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";

describeStripe("stripe-provider resolveWebhookSession", () => {
  test("throws for an invalid webhook payment status", async () => {
    await expect(
      stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            ...stripeCheckoutSession({ id: "cs_bad_status" }),
            payment_status: "completed",
          },
        },
        id: "evt_bad_status",
        type: "checkout.session.completed",
      }),
    ).rejects.toThrow();
  });

  test("throws for malformed checkout fields when the webhook has a session ID", async () => {
    await expect(
      stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            ...stripeCheckoutSession({ id: "cs_bad_amount" }),
            amount_total: "1000",
          },
        },
        id: "evt_bad_amount",
        type: "checkout.session.completed",
      }),
    ).rejects.toThrow();
  });

  test("looks up even a one-character session ID", async () => {
    // Only a genuinely absent id is refused; any id Stripe sends, however
    // short, must still be fetched rather than dismissed unread.
    const retrieve = stub(
      stripeApi,
      "retrieveCheckoutSession",
      () => Promise.resolve(null),
    );
    try {
      expect(
        await stripePaymentProvider.resolveWebhookSession({
          data: { object: { ...stripeCheckoutSession(), id: "x" } },
          id: "evt_short_id",
          type: "checkout.session.completed",
        }),
      ).toBeNull();
      expect(retrieve.calls.map((call) => call.args)).toEqual([["x"]]);
    } finally {
      retrieve.restore();
    }
  });

  test("refuses a paid session Stripe gave no payment intent for", async () => {
    // The blank stand-in for a missing intent must stay blank: a made-up
    // reference would read as a real charge id, and the session would be
    // booked as refundable when nothing could ever be refunded.
    const paidWithoutIntent = stripeCheckoutSession({
      id: "cs_no_intent",
      metadata: {
        email: "nointent@example.com",
        items: '[{"e":1,"q":1,"p":0}]',
        name: "No Intent",
      },
      payment_intent: null,
    });
    const retrieve = stub(
      stripeApi,
      "retrieveCheckoutSession",
      () => Promise.resolve(paidWithoutIntent),
    );
    try {
      expect(
        await stripePaymentProvider.resolveWebhookSession({
          data: { object: paidWithoutIntent },
          id: "evt_no_intent",
          type: "checkout.session.completed",
        }),
      ).toEqual({
        provider: "stripe",
        reason: "blank_reference",
        sessionId: "cs_no_intent",
      });
    } finally {
      retrieve.restore();
    }
  });

  test("returns null for a webhook checkout object without a session ID", async () => {
    const { id: _id, ...withoutId } = stripeCheckoutSession();
    expect(
      await stripePaymentProvider.resolveWebhookSession({
        data: { object: withoutId },
        id: "evt_without_session",
        type: "checkout.session.completed",
      }),
    ).toBeNull();
  });

  test("keeps a valid foreign checkout session ignored", async () => {
    const foreign = stripeCheckoutSession({
      id: "cs_foreign",
      metadata: { foreign: "metadata" },
    });
    const retrieve = stub(
      stripeApi,
      "retrieveCheckoutSession",
      () => Promise.resolve(foreign),
    );
    try {
      expect(
        await stripePaymentProvider.resolveWebhookSession({
          data: { object: foreign },
          id: "evt_foreign",
          type: "checkout.session.completed",
        }),
      ).toBeNull();
      expect(retrieve.calls.map((call) => call.args)).toEqual([["cs_foreign"]]);
    } finally {
      retrieve.restore();
    }
  });
});
