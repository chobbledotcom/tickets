import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > Stripe settings", { db: true }, () => {
  test("keeps both prior webhook values when the endpoint ID write fails", async () => {
    await settings.update.stripe.webhookConfig({
      endpointId: "we_old",
      secret: "whsec_old",
    });
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
        settings.update.stripe.webhookConfig({
          endpointId: "we_new",
          secret: "whsec_new",
        }),
      ).rejects.toThrow("endpoint id write failed");
    } finally {
      await getDb().execute("DROP TRIGGER fail_stripe_endpoint_id");
    }

    settings.invalidateCache();
    await settings.loadKeys([
      CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
      CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
    ]);
    expect(settings.stripe.webhookEndpointId).toBe("we_old");
    expect(settings.stripe.webhookSecret).toBe("whsec_old");
  });
});
