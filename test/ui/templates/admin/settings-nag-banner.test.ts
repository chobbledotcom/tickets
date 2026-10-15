import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getSettingsNagItems } from "#shared/settings-nags.ts";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { withSetting } from "#test-utils/settings.ts";

describeWithEnv(
  "SettingsNagBanner",
  { env: { BUNNY_API_KEY: "k", BUNNY_DNS_ZONE_ID: "z", BUNNY_SCRIPT_ID: "s" } },
  () => {
    test("SettingsNagBanner() with no args renders base sync nags", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "",
          payment_provider_setting: null,
        },
        () => {
          const html = String(SettingsNagBanner());
          assertStringIncludes(html, "Finish setting up your site");
          assertStringIncludes(
            html,
            'href="/admin/settings#settings-payment-provider"',
          );
          assertStringIncludes(
            html,
            'href="/admin/settings#settings-business-email"',
          );
          assertStringIncludes(
            html,
            'href="/admin/settings-advanced#settings-custom-domain"',
          );
          assert(
            !html.includes("superuser"),
            "the value should not contain the searched item",
          );
        },
      );
    });

    test("SettingsNagBanner({ items: undefined }) also falls back to base nags", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "",
          payment_provider_setting: null,
        },
        () => {
          const html = String(SettingsNagBanner({}));
          assertStringIncludes(html, "Finish setting up your site");
          assertStringIncludes(
            html,
            'href="/admin/settings#settings-payment-provider"',
          );
        },
      );
    });

    const superuserItem = {
      href: "/admin/settings#settings-superuser",
      id: "superuser" as const,
      label: "Choose whether to enable a superuser recovery account.",
    };

    test("renders superuser nag link when items contain the superuser item", () => {
      const items = [superuserItem];
      const html = String(SettingsNagBanner({ items }));
      assertStringIncludes(html, 'href="/admin/settings#settings-superuser"');
      assertStringIncludes(
        html,
        "Choose whether to enable a superuser recovery account.",
      );
    });

    test("renders multiple nags when items contain both base and superuser nags", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "",
          payment_provider_setting: null,
        },
        () => {
          const baseNags = getSettingsNagItems();
          const items = [...baseNags, superuserItem];
          const html = String(SettingsNagBanner({ items }));
          assertStringIncludes(
            html,
            'href="/admin/settings#settings-payment-provider"',
          );
          assertStringIncludes(
            html,
            'href="/admin/settings#settings-business-email"',
          );
          assertStringIncludes(
            html,
            'href="/admin/settings-advanced#settings-custom-domain"',
          );
          assertStringIncludes(
            html,
            'href="/admin/settings#settings-superuser"',
          );
        },
      );
    });

    test("renders nothing (null) when items array is empty", () => {
      const result = SettingsNagBanner({ items: [] });
      expect(result).toBeNull();
    });

    test("superuser nag label text matches exactly", () => {
      const items = [superuserItem];
      const html = String(SettingsNagBanner({ items }));
      assertStringIncludes(
        html,
        "Choose whether to enable a superuser recovery account.",
      );
    });
  },
);
