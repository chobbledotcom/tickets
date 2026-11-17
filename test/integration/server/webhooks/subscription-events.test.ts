/** The subscription deliveries of the payment webhook: each one reads Stripe,
 * then records the renewals and the status that the read reports. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import type { WebhookEvent } from "#shared/payments.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  MONTHLY,
  renewalLegs,
  statusOf,
  subscribe,
  type TestBooking,
} from "#test-utils/db-helpers/subscriptions.ts";
import { mockWebhookRequest, withMocks } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { stripePaidInvoice } from "#test-utils/stripe/fixtures.ts";
import { withStripeRenewals } from "#test-utils/stripe/subscription-checkout.ts";
import {
  expectWebhookRejected,
  postWebhookAndAssert,
} from "#test-utils/webhooks.ts";

type StubbedEvent = Parameters<typeof stubWebhookVerify>[0];

/** A signed invoice delivery for `subscriptionId`. */
const invoiceDelivery = (
  type: string,
  subscriptionId: string,
): StubbedEvent => ({
  data: {
    object: {
      parent: {
        subscription_details: { subscription: subscriptionId },
        type: "subscription_details",
      },
    },
  },
  id: `evt_${type}`,
  type,
});

/** A signed delivery of a subscription object. */
const subscriptionDelivery = (
  type: string,
  subscriptionId: string,
): StubbedEvent => ({
  data: { object: { id: subscriptionId } },
  id: `evt_${type}`,
  type,
});

/** A read stub that fails the test if a delivery reads Stripe. */
const readNever = () =>
  stub(stripeApi, "readSubscription", () => {
    throw new Error("This delivery must not read Stripe");
  });

/** Post `event` through the webhook route with a stubbed signature check. */
const postDelivery = async (
  event: WebhookEvent,
  assertions?: (json: Record<string, unknown>) => void,
): Promise<void> => {
  const verify = await stubWebhookVerify(event);
  await postWebhookAndAssert(() => verify.restore(), 200, assertions);
};

/** Post `event` and report the plain answer it gets. */
const postAndReadText = async (
  event: WebhookEvent,
): Promise<{ body: string; status: number }> => {
  const verify = await stubWebhookVerify(event);
  try {
    const response = await handleRequest(
      mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
    );
    return { body: await response.text(), status: response.status };
  } finally {
    verify.restore();
  }
};

/** A subscriber who booked before the site took Stripe payments. With a
 * provider on, the booking page leaves for the provider's checkout instead of
 * booking, so the row lands first. */
const stripeSubscriber = async (
  name: string,
  plan = MONTHLY,
): Promise<TestBooking> => {
  const booking = await subscribe(name, plan);
  await setupStripe();
  return booking;
};

/** Post `event` while Stripe must not be read, and assert the plain ack. */
const expectNoWork = async (event: WebhookEvent): Promise<void> => {
  await withMocks(
    () => ({ read: readNever() }),
    () =>
      postDelivery(event, (json) => {
        expect(json).toEqual({ received: true });
      }),
  );
};

describeWithEnv("subscription webhook deliveries", { db: true }, () => {
  test("records a renewal that Stripe reports as paid, and its status", async () => {
    const ada = await stripeSubscriber("Ada");
    await withStripeRenewals(
      "active",
      [
        stripePaidInvoice({ id: "in_cycle" }),
        stripePaidInvoice({
          billing_reason: "subscription_create",
          id: "in_first",
        }),
      ],
      async () => {
        await postDelivery(
          invoiceDelivery("invoice.paid", "sub_ada"),
          (json) => {
            expect(json.received).toBe(true);
            expect(json.processed).toBe(true);
          },
        );
      },
    );
    expect((await renewalLegs("in_cycle")).map((leg) => leg.amount)).toEqual([
      600, 500, 100,
    ]);
    expect(await renewalLegs("in_first")).toEqual([]);
    expect(await statusOf(ada)).toBe("active");
  });

  test("records the status of a subscription that changed with no payment", async () => {
    const ada = await stripeSubscriber("Ada");
    await withStripeRenewals("past_due", [], async () => {
      await postDelivery(
        subscriptionDelivery("customer.subscription.updated", "sub_ada"),
      );
    });
    expect(await statusOf(ada)).toBe("past_due");
  });

  test("posts one invoice once when Stripe sends the same delivery twice", async () => {
    await stripeSubscriber("Ada");
    await withStripeRenewals(
      "active",
      [stripePaidInvoice({ id: "in_twice" })],
      async () => {
        await postDelivery(invoiceDelivery("invoice.paid", "sub_ada"));
        await postDelivery(invoiceDelivery("invoice.paid", "sub_ada"));
      },
    );
    expect(await renewalLegs("in_twice")).toHaveLength(3);
  });

  test("ends the row, and keeps the money of the last period", async () => {
    const ada = await stripeSubscriber("Ada");
    await withStripeRenewals(
      "canceled",
      [stripePaidInvoice({ id: "in_last" })],
      async () => {
        await postDelivery(
          subscriptionDelivery("customer.subscription.deleted", "sub_ada"),
        );
      },
    );
    expect(await renewalLegs("in_last")).toHaveLength(3);
    expect(await statusOf(ada)).toBe("canceled");
  });

  test("acknowledges a delivery for a subscription with no live row", async () => {
    await setupStripe();
    await expectNoWork(invoiceDelivery("invoice.paid", "sub_another_site"));
  });

  test("does not reopen an ended row", async () => {
    const ada = await stripeSubscriber("Ada", {
      ...MONTHLY,
      status: "canceled",
    });
    await expectNoWork(invoiceDelivery("invoice.paid", "sub_ada"));
    expect(await statusOf(ada)).toBe("canceled");
  });

  test("asks Stripe to deliver again when its read fails", async () => {
    const ada = await stripeSubscriber("Ada");
    await withMocks(
      () => ({
        read: stub(stripeApi, "readSubscription", () =>
          Promise.resolve({
            reason: "timeout",
            status: "unavailable" as const,
          }),
        ),
      }),
      async () => {
        expect(
          await postAndReadText(invoiceDelivery("invoice.paid", "sub_ada")),
        ).toEqual({ body: "Subscription could not be read", status: 503 });
      },
    );
    expect(await statusOf(ada)).toBe("trialing");
  });

  test("leaves a signed invoice that no subscription made to the booking path", async () => {
    await setupStripe();
    await expectNoWork({
      data: { object: { parent: null } },
      id: "evt_plain",
      type: "invoice.paid",
    });
  });

  test("leaves a delivery of another kind to the booking path", async () => {
    await setupStripe();
    await expectNoWork({
      data: { object: { id: "ch_1" } },
      id: "evt_1",
      type: "charge.refunded",
    });
  });

  test("refuses a subscription delivery that names no subscription", async () => {
    await setupStripe();
    await expectWebhookRejected(
      {
        data: { object: {} },
        id: "evt_broken",
        type: "customer.subscription.updated",
      },
      'Expected "id"',
    );
  });
});
