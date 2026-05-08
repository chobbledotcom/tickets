import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv, withSetting } from "#test-utils";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";

describeWithEnv(
  "SettingsNagBanner",
  { env: { BUNNY_API_KEY: "k", BUNNY_SCRIPT_ID: "s", BUNNY_DNS_ZONE_ID: "z" } },
  () => {
    test("returns null when no nag items are pending", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "a@b.com",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          expect(SettingsNagBanner()).toBeNull();
        },
      );
    });

    test("renders an item per pending nag with deep links", async () => {
      await withSetting(
        {
          payment_provider_setting: null,
          business_email: "",
          custom_domain: "",
          bunny_subdomain: "",
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
