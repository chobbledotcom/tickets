import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { t } from "#i18n";
import type { CheckoutIntent } from "#shared/payments.ts";
import type { StripeSubscription } from "#shared/stripe/schemas.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { firstRecurringChargeAt } from "#shared/subscriptions/plan.ts";
import { checkoutIntent, checkoutItem } from "#test-utils/checkout-items.ts";
import { withMocks } from "#test-utils/mocks.ts";
import { asSession } from "#test-utils/payment-session.ts";
import { withSetting } from "#test-utils/settings.ts";
import {
  stripeCheckoutSession,
  stripeClient,
  stripeSubscription,
} from "#test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test-utils/stripe/harness.ts";

const NOW_MS = Date.parse("2026-11-10T09:00:00Z");
const ADDED = { mode: "add_to_total", rateBasisPoints: 2000 } as const;

const monthly = checkoutItem({
  listingId: 7,
  name: "Club",
  quantity: 2,
  recurring: { interval: "month", price: 500 },
  slug: "club",
  unitPrice: 1000,
});

const subscriptionSession = stripeCheckoutSession({
  id: "cs_sub",
  metadata: {
    email: "member@example.com",
    items: '[{"e":7,"q":2,"p":2000}]',
    name: "Member",
  },
  mode: "subscription",
  payment_intent: null,
  subscription: "sub_test",
});

/** Stub the subscription read Stripe answers with `impl`, then run `body`. */
const whileReadingSubscription = async (
  impl: () => Promise<StripeSubscription>,
  body: () => Promise<void>,
) => {
  const client = await stripeClient();
  await withMocks(
    () => stub(client.subscriptions, "retrieveWithFirstPayment", impl),
    body,
  );
};

/** The parameters a checkout of `intent` sends to Stripe. */
const sentParams = async (intent: CheckoutIntent) => {
  const client = await stripeClient();
  const create = stub(client.checkout.sessions, "create", () =>
    Promise.resolve(stripeCheckoutSession()),
  );
  try {
    await stripePaymentProvider.createCheckoutSession(
      intent,
      "http://localhost",
    );
    return create.calls[0]!.args[0];
  } finally {
    create.restore();
  }
};

describeStripe("Stripe subscription checkout", () => {
  test("adds the recurring line and holds it back for one period", async () => {
    using _time = new FakeTime(NOW_MS);
    await withSetting({ booking_fee: "0", currency: "GBP" }, async () => {
      const { recurring: _, ...oneOff } = monthly;
      const ordinary = await sentParams(
        checkoutIntent({ items: [oneOff], taxPolicy: ADDED }),
      );
      const subscribed = await sentParams(
        checkoutIntent({ items: [monthly], taxPolicy: ADDED }),
      );
      expect(subscribed).toEqual({
        ...ordinary,
        line_items: [
          ...ordinary.line_items!,
          {
            price_data: {
              currency: "gbp",
              product_data: {
                description: "Tickets (x2)",
                name: "Ticket: Club",
              },
              recurring: { interval: "month" },
              unit_amount: 1200,
            },
            quantity: 1,
          },
        ],
        metadata: subscribed.metadata,
        mode: "subscription",
        subscription_data: {
          metadata: { listing_id: "7" },
          trial_end: firstRecurringChargeAt(NOW_MS / 1000, "month"),
        },
      });
      expect(ordinary.mode).toBe("payment");
      expect(Object.keys(ordinary)).not.toContain("subscription_data");
    });
  });

  test("refuses a subscription deposit before it asks Stripe", async () => {
    const client = await stripeClient();
    const create = stub(client.checkout.sessions, "create", () =>
      Promise.resolve(stripeCheckoutSession()),
    );
    try {
      expect(
        await stripePaymentProvider.createCheckoutSession(
          checkoutIntent({ items: [monthly], reservationAmount: "10%" }),
          "http://localhost",
        ),
      ).toEqual({ error: t("payment.error.subscription_no_deposit") });
      expect(create.calls.length).toBe(0);
    } finally {
      create.restore();
    }
  });

  test("reads the started plan and its first payment from the webhook", async () => {
    await whileReadingSubscription(
      () =>
        Promise.resolve(stripeSubscription({ metadata: { listing_id: "7" } })),
      async () => {
        const session = asSession(
          await stripePaymentProvider.resolveWebhookSession({
            data: { object: subscriptionSession },
            id: "evt_sub",
            type: "checkout.session.completed",
          }),
        );
        expect(session.paymentReference).toBe("pi_first");
        expect(session.subscription).toEqual({
          amount: 500,
          id: "sub_test",
          interval: "month",
          listingId: 7,
          status: "trialing",
        });
      },
    );
  });

  test("stops the callback when Stripe answers for another subscription", async () => {
    await whileReadingSubscription(
      () => Promise.resolve(stripeSubscription({ id: "sub_other" })),
      async () => {
        await expect(
          stripePaymentProvider.resolveWebhookSession({
            data: { object: subscriptionSession },
            id: "evt_sub",
            type: "checkout.session.completed",
          }),
        ).rejects.toThrow(
          'Stripe subscription sub_test could not be read: {"reason":"mismatched_id","status":"invalid"}',
        );
      },
    );
  });

  test("reads a payment-mode session without asking for a subscription", async () => {
    const read = stub(stripeApi, "readSubscription");
    try {
      const session = asSession(
        await stripePaymentProvider.resolveWebhookSession({
          data: {
            object: stripeCheckoutSession({
              metadata: subscriptionSession.metadata,
            }),
          },
          id: "evt_pay",
          type: "checkout.session.completed",
        }),
      );
      expect(session.paymentReference).toBe("pi_test");
      expect(Object.keys(session)).not.toContain("subscription");
      expect(read.calls.length).toBe(0);
    } finally {
      read.restore();
    }
  });
});

describe("subscription session without a subscription", () => {
  test("a subscription-mode session that names none reads as a payment", async () => {
    const read = stub(stripeApi, "readSubscription");
    try {
      const session = asSession(
        await stripePaymentProvider.resolveWebhookSession({
          data: {
            object: {
              ...subscriptionSession,
              payment_intent: "pi_x",
              subscription: null,
            },
          },
          id: "evt_none",
          type: "checkout.session.completed",
        }),
      );
      expect(session.paymentReference).toBe("pi_x");
      expect(read.calls.length).toBe(0);
    } finally {
      read.restore();
    }
  });
});
