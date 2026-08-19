import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { TEMPLATE_KEYS } from "#db/settings/apply.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
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
});
