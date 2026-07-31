import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import { stripeApi } from "#shared/stripe.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { SESSION_RESOURCE } from "#test/shared/db/payments/fixtures.ts";
import { signedWebhook } from "#test/test-utils/stripe/fixtures.ts";
import { describeStripe } from "#test/test-utils/stripe/harness.ts";

describeStripe("Stripe provider webhook", () => {
  const verify = async (event: unknown) => {
    const secret = "whsec_provider_notice";
    settings.setForTest({ stripe_webhook_secret: secret });
    const { payload, signature } = await signedWebhook(event, secret);
    return stripePaymentProvider.verifyWebhookSignature(
      payload,
      signature,
      "https://example.com/payment/webhook",
      new TextEncoder().encode(payload),
    );
  };

  test("returns the exact Checkout Session resource from a signed notice", async () => {
    expect(
      await verify({
        data: { object: { id: SESSION_RESOURCE.id } },
        id: "evt_checkout_complete",
        type: "checkout.session.completed",
      }),
    ).toEqual({
      notice: {
        eventId: "evt_checkout_complete",
        resource: SESSION_RESOURCE,
        type: "checkout.session.completed",
      },
      valid: true,
    });
  });

  test("ignores another valid Stripe event type", async () => {
    expect(
      await verify({
        data: { object: { id: "pi_other" } },
        id: "evt_other",
        type: "payment_intent.succeeded",
      }),
    ).toEqual({ notice: null, valid: true });
  });

  test("delegates webhook endpoint setup", async () => {
    using setup = stub(stripeApi, "setupWebhookEndpoint", () =>
      Promise.resolve({
        endpointId: "we_provider",
        secret: "whsec_provider",
        success: true as const,
      }),
    );
    expect(
      await stripePaymentProvider.setupWebhookEndpoint(
        "sk_test_provider",
        "https://example.com/payment/webhook",
      ),
    ).toEqual({
      endpointId: "we_provider",
      secret: "whsec_provider",
      success: true,
    });
    expect(setup.calls[0]?.args).toEqual([
      "sk_test_provider",
      "https://example.com/payment/webhook",
    ]);
  });
});
