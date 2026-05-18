import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";
import { describeWithEnv, withSetting } from "#test-utils";

describeWithEnv(
  "SettingsNagBanner",
  { env: { BUNNY_API_KEY: "k", BUNNY_DNS_ZONE_ID: "z", BUNNY_SCRIPT_ID: "s" } },
  () => {
    test("returns null when no nag items are pending", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "example.com",
          payment_provider_setting: "stripe",
        },
        () => {
          expect(SettingsNagBanner()).toBeNull();
        },
      );
    });

    test("renders an item per pending nag with deep links", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "",
          payment_provider_setting: null,
        },
        () => {
          const html = String(SettingsNagBanner());
          expect(html).toContain("Finish setting up your site");
          expect(html).toContain(
            'href="/admin/settings#settings-payment-provider"',
          );
          expect(html).toContain(
            'href="/admin/settings#settings-business-email"',
          );
          expect(html).toContain(
            'href="/admin/settings-advanced#settings-custom-domain"',
          );
        },
      );
    });
  },
);
