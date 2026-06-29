import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getSettingsNagItems } from "#shared/settings-nags.ts";
import { SettingsNagBanner } from "#templates/admin/settings-nag-banner.tsx";
import { describeWithEnv, withSetting } from "#test-utils";

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
          expect(html).not.toContain("superuser");
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
          expect(html).toContain("Finish setting up your site");
          expect(html).toContain(
            'href="/admin/settings#settings-payment-provider"',
          );
        },
      );
    });

    test("renders superuser nag link when items contain the superuser item", () => {
      const items = [
        {
          href: "/admin/settings#settings-superuser",
          id: "superuser" as const,
          label: "Choose whether to enable a superuser recovery account.",
        },
      ];
      const html = String(SettingsNagBanner({ items }));
      expect(html).toContain('href="/admin/settings#settings-superuser"');
      expect(html).toContain(
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
          const items = [
            ...baseNags,
            {
              href: "/admin/settings#settings-superuser",
              id: "superuser" as const,
              label: "Choose whether to enable a superuser recovery account.",
            },
          ];
          const html = String(SettingsNagBanner({ items }));
          expect(html).toContain(
            'href="/admin/settings#settings-payment-provider"',
          );
          expect(html).toContain(
            'href="/admin/settings#settings-business-email"',
          );
          expect(html).toContain(
            'href="/admin/settings-advanced#settings-custom-domain"',
          );
          expect(html).toContain('href="/admin/settings#settings-superuser"');
        },
      );
    });

    test("renders nothing (null) when items array is empty", () => {
      const result = SettingsNagBanner({ items: [] });
      expect(result).toBeNull();
    });

    test("superuser nag label text matches exactly", () => {
      const items = [
        {
          href: "/admin/settings#settings-superuser",
          id: "superuser" as const,
          label: "Choose whether to enable a superuser recovery account.",
        },
      ];
      const html = String(SettingsNagBanner({ items }));
      expect(html).toContain(
        "Choose whether to enable a superuser recovery account.",
      );
    });
  },
);
