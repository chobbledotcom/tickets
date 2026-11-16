import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { stripeCheckoutSession } from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

describeStripe("stripe-provider resolveWebhookSession", () => {
  test("throws for an invalid webhook payment status", async () => {
    await expect(
      stripePaymentProvider.resolveWebhookSession({
        data: {
          object: {
            ...stripeCheckoutSession({ id: "cs_bad_status" }),
            expires_at: 456,
            payment_status: "completed",
            status: "complete",
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

  for (const { name, session, expected } of [
    {
      expected: expect.objectContaining({
        provider: "stripe",
        reason: "blank_reference",
        sessionId: "cs_no_intent",
      }),
      name: "refuses a paid session Stripe gave no payment intent for",
      session: stripeCheckoutSession({
        id: "cs_no_intent",
        metadata: {
          email: "nointent@example.com",
          items: '[{"e":1,"q":1,"p":0}]',
          name: "No Intent",
        },
        payment_intent: null,
      }),
    },
    {
      expected: null,
      name: "keeps a valid foreign checkout session ignored",
      session: stripeCheckoutSession({
        id: "cs_foreign",
        metadata: { foreign: "metadata" },
      }),
    },
  ]) {
    test(name, async () => {
      using _retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
        Promise.resolve(session),
      );
      expect(
        await stripePaymentProvider.resolveWebhookSession({
          data: { object: session },
          id: "evt_session",
          type: "checkout.session.completed",
        }),
      ).toEqual(expected);
    });
  }

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
});
