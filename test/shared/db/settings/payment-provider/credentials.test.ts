import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > settings payment credentials", { db: true }, () => {
  describe("the Stripe secret key", () => {
    test("reports no key on a fresh database", () => {
      expect(settings.stripe.hasKey).toBe(false);
    });

    test("reports a key once one is saved", async () => {
      await settings.update.stripe.secretKey("sk_test_123");
      expect(settings.stripe.hasKey).toBe(true);
    });

    test("reads an empty secret key on a fresh database", () => {
      expect(settings.stripe.secretKey).toBe("");
    });

    test("reads a saved secret key back decrypted", async () => {
      await settings.update.stripe.secretKey("sk_test_secret_key");
      const key = settings.stripe.secretKey;
      expect(key).toBe("sk_test_secret_key");
    });

    test("stores the secret key encrypted", async () => {
      await settings.update.stripe.secretKey("sk_test_encrypted");
      await settings.loadKeys([CONFIG_KEYS.STRIPE_SECRET_KEY]);
      const rawValue = settings.getCachedRaw(CONFIG_KEYS.STRIPE_SECRET_KEY);
      expect(rawValue).toMatch(/^enc:1:/);
      expect(settings.stripe.secretKey).toBe("sk_test_encrypted");
    });

    test("overwrites an existing secret key", async () => {
      await settings.update.stripe.secretKey("sk_test_first");
      expect(settings.stripe.secretKey).toBe("sk_test_first");

      await settings.update.stripe.secretKey("sk_test_second");
      expect(settings.stripe.secretKey).toBe("sk_test_second");
    });

    test("reports no key mode when no key is saved", () => {
      expect(settings.stripe.keyMode).toBeNull();
    });

    test("reports a test key mode for an sk_test_ key", async () => {
      await settings.update.stripe.secretKey("sk_test_abc123");
      expect(settings.stripe.keyMode).toBe("test");
    });

    test("reports a live key mode for an sk_live_ key", async () => {
      await settings.update.stripe.secretKey("sk_live_abc123");
      expect(settings.stripe.keyMode).toBe("live");
    });

    test("reports no key mode for an unrecognised prefix", async () => {
      await settings.update.stripe.secretKey("rk_invalid_abc123");
      expect(settings.stripe.keyMode).toBeNull();
    });
  });

  describe("saving the Stripe credentials", () => {
    const current = {
      secretKey: "sk_test_current",
      webhookEndpointId: "we_current",
      webhookSecret: "whsec_current",
    };
    const replacement = {
      secretKey: "sk_test_replacement",
      webhookEndpointId: "we_replacement",
      webhookSecret: "whsec_replacement",
    };

    test("replaces the current credentials", async () => {
      await settings.update.stripe.configure(current);
      await settings.update.stripe.configure(replacement);

      expect({
        secretKey: settings.stripe.secretKey,
        webhookEndpointId: settings.stripe.webhookEndpointId,
        webhookSecret: settings.stripe.webhookSecret,
      }).toEqual({
        ...replacement,
      });
    });

    test("does not change the payment provider", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.stripe.configure(replacement);

      expect(settings.paymentProvider).toBe("square");
      expect(settings.paymentProviderSetting).toBe("square");
    });
  });

  describe("clearing a stored credential", () => {
    test("update.stripe.secretKey with empty string sets empty string", async () => {
      await settings.update.stripe.secretKey("sk_test_abc");
      expect(settings.stripe.secretKey).toBe("sk_test_abc");
      await settings.update.stripe.secretKey("");
      expect(settings.stripe.secretKey).toBe("");
    });

    test("update.square.accessToken with empty string sets empty string", async () => {
      await settings.update.square.accessToken("token_123");
      expect(settings.square.accessToken).toBe("token_123");
      await settings.update.square.accessToken("");
      expect(settings.square.accessToken).toBe("");
    });

    test("update.square.webhookSignatureKey with empty string sets empty string", async () => {
      await settings.update.square.webhookSignatureKey("sig_key_123");
      expect(settings.square.webhookSignatureKey).toBe("sig_key_123");
      await settings.update.square.webhookSignatureKey("");
      expect(settings.square.webhookSignatureKey).toBe("");
    });

    test("update.square.locationId with empty string sets empty string", async () => {
      await settings.update.square.locationId("loc_123");
      expect(settings.square.locationId).toBe("loc_123");
      await settings.update.square.locationId("");
      expect(settings.square.locationId).toBe("");
    });
  });

  test("keeps all prior credentials when the endpoint ID write fails", async () => {
    await settings.update.stripe.configure({
      secretKey: "sk_test_old",
      webhookEndpointId: "we_old",
      webhookSecret: "whsec_old",
    });
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
        settings.update.stripe.configure({
          secretKey: "sk_test_new",
          webhookEndpointId: "we_new",
          webhookSecret: "whsec_new",
        }),
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
