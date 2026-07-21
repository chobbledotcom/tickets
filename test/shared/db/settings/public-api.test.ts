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
  });

  describe("Stripe activation", () => {
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

    test("replaces the current credentials and provider", async () => {
      await settings.update.stripe.activate(current);
      await settings.update.stripe.activate(replacement);

      expect({
        paymentProvider: settings.paymentProvider,
        paymentProviderSetting: settings.paymentProviderSetting,
        secretKey: settings.stripe.secretKey,
        webhookEndpointId: settings.stripe.webhookEndpointId,
        webhookSecret: settings.stripe.webhookSecret,
      }).toEqual({
        paymentProvider: "stripe",
        paymentProviderSetting: "stripe",
        ...replacement,
      });
    });

    test("persists the Stripe provider selection", async () => {
      await settings.update.stripe.activate(replacement);
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.PAYMENT_PROVIDER]);

      expect(settings.paymentProvider).toBe("stripe");
      expect(settings.paymentProviderSetting).toBe("stripe");
    });
  });
});
