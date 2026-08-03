import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { TEMPLATE_KEYS } from "#shared/db/settings/apply.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > settings public API", { db: true }, () => {
  test("reports absent provider credentials as not configured", () => {
    settings.setForTest({
      address_lookup_api_key: "",
      email_api_key: "",
      sms_gateway_passphrase: "",
      sms_gateway_password: "",
      sms_gateway_webhook_secret: "",
      square_access_token: "",
    });

    expect({
      addressLookup: settings.addressLookup.hasKey,
      email: settings.email.hasApiKey,
      smsPassphrase: settings.smsGateway.hasPassphrase,
      smsPassword: settings.smsGateway.hasPassword,
      smsWebhook: settings.smsGateway.hasWebhookSecret,
      square: settings.square.hasToken,
    }).toEqual({
      addressLookup: false,
      email: false,
      smsPassphrase: false,
      smsPassword: false,
      smsWebhook: false,
      square: false,
    });
  });

  test("returns the stored listings calendar grouping", () => {
    settings.setForTest({ calendar_feeds_group_by: "listings" });

    expect(settings.calendarFeedsGroupBy).toBe("listings");
  });

  describe("email templates", () => {
    const templateKey = TEMPLATE_KEYS["confirmation:subject"];
    const subject = "Your updated ticket";

    test("updates the current snapshot", async () => {
      await settings.update.email.template("confirmation", "subject", subject);

      expect(settings.email.template("confirmation", "subject")).toBe(subject);
    });

    test("persists an encrypted template", async () => {
      await settings.update.email.template("confirmation", "subject", subject);
      settings.invalidateCache();
      await settings.loadKeys([templateKey]);

      expect(settings.email.template("confirmation", "subject")).toBe(subject);
      expect(settings.getCachedRaw(templateKey)).toMatch(/^enc:1:/);
    });
  });

  describe("listing defaults", () => {
    const defaults = { hidden: true, minimumDaysBefore: 4 } as const;

    test("updates the current snapshot", async () => {
      await settings.update.listingDefaults(defaults);

      expect(settings.listingDefaults).toEqual(defaults);
    });

    test("persists encrypted defaults", async () => {
      await settings.update.listingDefaults(defaults);
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.LISTING_DEFAULTS]);

      expect(settings.listingDefaults).toEqual(defaults);
      expect(settings.getCachedRaw(CONFIG_KEYS.LISTING_DEFAULTS)).toMatch(
        /^enc:1:/,
      );
    });
  });

  describe("payment provider", () => {
    const reloadPaymentProviderSettings = async (): Promise<void> => {
      settings.invalidateCache();
      await settings.loadKeys([
        CONFIG_KEYS.PAYMENT_PROVIDER,
        CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
      ]);
    };

    const expectDisabledWith = (remembered: "stripe" | "square"): void => {
      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBe("none");
      expect(settings.lastActivePaymentProvider).toBe(remembered);
      expect(settings.getCachedRaw(CONFIG_KEYS.PAYMENT_PROVIDER)).toBe("none");
      expect(
        settings.getCachedRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER),
      ).toBe(remembered);
    };

    test("replaces the current provider", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.paymentProvider("stripe");

      expect(settings.paymentProvider).toBe("stripe");
      expect(settings.paymentProviderSetting).toBe("stripe");
    });

    test("sets the current provider to none", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.update.setPaymentProviderNone();

      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBe("none");
    });

    test("persists the explicit none setting", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.update.setPaymentProviderNone();
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);

      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBe("none");
    });

    test("remembers the most recently activated provider", async () => {
      // Activating twice proves the remembered provider is replaced, not
      // appended (a fresh snapshot read catches a `+=` drift), and a reload
      // from the DB catches a missing persistence write.
      await settings.update.paymentProvider("stripe");
      await settings.update.paymentProvider("square");
      expect(settings.lastActivePaymentProvider).toBe("square");

      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER]);
      expect(settings.lastActivePaymentProvider).toBe("square");
    });

    test("keeps the last provider after new sales are switched off", async () => {
      await settings.update.paymentProvider("stripe");
      await settings.update.setPaymentProviderNone();
      expect(settings.paymentProvider).toBeNull();
      expect(settings.lastActivePaymentProvider).toBe("stripe");

      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER]);
      expect(settings.lastActivePaymentProvider).toBe("stripe");
    });

    test("keeps a newer active provider during a stale credential save", async () => {
      await settings.update.paymentProvider("square");

      await settings.update.paymentProviderAfterCredentialSave("stripe", false);

      expect(settings.paymentProvider).toBe("square");
      expect(settings.paymentProviderSetting).toBe("square");
    });

    test("refuses ambiguous activation until the old provider is recovered", async () => {
      await settings.update.stripe.secretKey("sk_test_ambiguous");
      await settings.update.square.accessToken("square-ambiguous");

      await expect(settings.update.paymentProvider("stripe")).rejects.toThrow(
        "Choose the provider for existing payments before enabling new sales",
      );
      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBeNull();
    });

    test("does not select saved credentials after sales are switched off", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.setPaymentProviderNone();

      await settings.update.paymentProviderAfterCredentialSave("stripe", true);

      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBe("none");
    });

    test("selects first-time credentials when no provider choice exists", async () => {
      await settings.update.clearPaymentProvider();

      await settings.update.paymentProviderAfterCredentialSave("stripe", true);

      expect(settings.paymentProvider).toBe("stripe");
      expect(settings.paymentProviderSetting).toBe("stripe");
    });

    test("keeps legacy credentials off when no provider choice exists", async () => {
      await settings.update.clearPaymentProvider();

      await settings.update.paymentProviderAfterCredentialSave("stripe", false);

      expect(settings.paymentProvider).toBeNull();
      expect(settings.paymentProviderSetting).toBe("none");
    });

    test("recovery updates the current request snapshot", async () => {
      await settings.update.clearPaymentProvider();

      await settings.update.recoverPaymentProvider("square");

      expectDisabledWith("square");
      await reloadPaymentProviderSettings();
      expectDisabledWith("square");
    });

    test("does not recover over a provider enabled by another request", async () => {
      await settings.update.clearPaymentProvider();
      const { executeWithoutCacheInvalidation } = await import(
        "#shared/db/client.ts"
      );
      await executeWithoutCacheInvalidation(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [CONFIG_KEYS.PAYMENT_PROVIDER, "stripe"],
      );

      await expect(
        settings.update.recoverPaymentProvider("square"),
      ).rejects.toThrow("Payment provider recovery is no longer available");

      await reloadPaymentProviderSettings();
      expect(settings.paymentProvider).toBe("stripe");
      expect(settings.lastActivePaymentProvider).toBeNull();
    });

    test("a second none save keeps the remembered provider", async () => {
      // Saving "none" again must not clear the provider remembered from the
      // first switch-off — existing payments still need it.
      await settings.update.paymentProvider("stripe");
      await settings.update.setPaymentProviderNone();
      await settings.update.setPaymentProviderNone();
      expect(settings.paymentProvider).toBeNull();
      expect(settings.lastActivePaymentProvider).toBe("stripe");
    });

    test("backfills the remembered provider for a pre-existing database", async () => {
      // A database that configured Stripe before last-active was tracked has
      // payment_provider set but last_active_payment_provider empty. Switching
      // new sales off must still remember Stripe so its existing payments stay
      // refundable.
      await settings.setRaw(CONFIG_KEYS.PAYMENT_PROVIDER, "stripe");
      await settings.setRaw(CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "");
      settings.invalidateCache();
      await settings.loadKeys([
        CONFIG_KEYS.PAYMENT_PROVIDER,
        CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
      ]);
      expect(settings.lastActivePaymentProvider).toBeNull();

      await settings.update.setPaymentProviderNone();
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER]);
      expect(settings.lastActivePaymentProvider).toBe("stripe");
    });

    test("throws on a corrupt non-empty remembered provider", async () => {
      await settings.setRaw(
        CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
        "garbage",
      );
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER]);
      expect(() => settings.lastActivePaymentProvider).toThrow(
        "Invalid last_active_payment_provider setting: garbage",
      );
    });

    test("disabling sales reads the current provider from the database, not the request snapshot", async () => {
      // Simulate the race: the snapshot loaded Stripe, then a concurrent
      // activation wrote Square to the DB. setPaymentProviderNone must read
      // the DB's current provider (Square), not the stale snapshot (Stripe).
      await settings.update.paymentProvider("stripe");
      // Write Square directly to the DB (bypassing the snapshot cache), so the
      // snapshot still holds the stale "stripe" value.
      const { executeWithoutCacheInvalidation } = await import(
        "#shared/db/client.ts"
      );
      await executeWithoutCacheInvalidation(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [CONFIG_KEYS.PAYMENT_PROVIDER, "square"],
      );
      await executeWithoutCacheInvalidation(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        [CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER, "square"],
      );
      // The snapshot still has Stripe from the request-start load.
      expect(settings.paymentProvider).toBe("stripe");

      await settings.update.setPaymentProviderNone();

      expectDisabledWith("square");
      await reloadPaymentProviderSettings();
      expectDisabledWith("square");
    });
  });

  describe("Stripe configuration", () => {
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
});
