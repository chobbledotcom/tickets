import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > Stripe settings", { db: true }, () => {
  test("keeps all prior credentials when the endpoint ID write fails", async () => {
    await settings.update.stripe.configure(
      {
        secretKey: "sk_test_old",
        webhookEndpointId: "we_old",
        webhookSecret: "whsec_old",
      },
      "stripe",
    );
    await settings.update.paymentProvider("square");
    await getDb().execute(`
      CREATE TRIGGER fail_stripe_endpoint_id
      BEFORE INSERT ON settings
      WHEN NEW.key = '${CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID}'
      BEGIN
        SELECT RAISE(ABORT, 'endpoint id write failed');
      END
    `);

    try {
      await expect(
        settings.update.stripe.configure(
          {
            secretKey: "sk_test_new",
            webhookEndpointId: "we_new",
            webhookSecret: "whsec_new",
          },
          "stripe",
        ),
      ).rejects.toThrow("endpoint id write failed");
    } finally {
      await getDb().execute("DROP TRIGGER fail_stripe_endpoint_id");
    }

    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.STRIPE_SECRET_KEY,
      CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
      CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
      CONFIG_KEYS.PAYMENT_PROVIDER,
    ]);
    expect(settings.stripe.secretKey).toBe("sk_test_old");
    expect(settings.stripe.webhookEndpointId).toBe("we_old");
    expect(settings.stripe.webhookSecret).toBe("whsec_old");
    expect(settings.paymentProvider).toBe("square");
  });
});
