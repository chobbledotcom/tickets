import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stripeApi } from "#shared/stripe.ts";
import { stubWebhookVerify } from "#test-utils/settings.ts";
import {
  expectWebhookKeptAndRefunded,
  stubRefundPayment,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks/stripe.ts";
import { checkoutSessionEvent } from "#test-utils/webhooks.ts";

test("keeps explicit null Stripe metadata", async () => {
  using _retrieve = stubRetrieveCheckoutSession({
    amountTotal: 1000,
    metadata: null,
    paymentIntent: "pi_null_metadata",
    sessionId: "cs_null_metadata",
  });

  const session = await stripeApi.retrieveCheckoutSession("cs_null_metadata");
  assertExists(session);
  expect(session.metadata).toBeNull();
});

test("restoring a Stripe refund stub twice is harmless", () => {
  const refund = stubRefundPayment();
  refund.restore();
  refund.restore();
});

test("missing refund amount fails before installing webhook stubs", async () => {
  const event = checkoutSessionEvent({
    amountTotal: 1000,
    eventId: "evt_missing_refund_amount",
    metadata: {},
    sessionId: "cs_missing_refund_amount",
  });
  delete event.data.object.amount_total;

  await expect(expectWebhookKeptAndRefunded(event)).rejects.toThrow(
    "must state amount_total",
  );

  using _verify = await stubWebhookVerify(event);
});
