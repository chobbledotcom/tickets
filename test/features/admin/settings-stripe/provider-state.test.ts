import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { adminFormPost } from "#test-utils/session.ts";
import {
  activateStripe,
  describeAdminSettings,
  withSuccessfulStripeWebhook,
} from "#test-utils/settings.ts";

describeAdminSettings(() => {
  test("rejects configuration in demo mode", async () => {
    setDemoModeForTest(true);
    try {
      const { response } = await adminFormPost("/admin/settings/stripe", {
        stripe_secret_key: "sk_test_demo",
      });
      expectFlash(response, "Cannot configure Stripe in demo mode", false);
    } finally {
      setDemoModeForTest(false);
    }
  });

  test("updates credentials without turning sales back on", async () => {
    await activateStripe("whsec_sales_off");
    await settings.update.setPaymentProviderNone();

    await withSuccessfulStripeWebhook(async () => {
      const { response } = await adminFormPost("/admin/settings/stripe", {
        stripe_secret_key: "sk_test_sales_off",
      });
      expect(response.status).toBe(302);
      expect(settings.paymentProvider).toBeNull();
      expect(settings.lastActivePaymentProvider).toBe("stripe");
      expect(settings.stripe.secretKey).toBe("sk_test_sales_off");
    });
  });
});
