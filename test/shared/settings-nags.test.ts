import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv, withSetting } from "#test-utils";
import { getSettingsNagItems } from "#shared/settings-nags.ts";

describeWithEnv(
  "getSettingsNagItems",
  { env: { BUNNY_API_KEY: "k", BUNNY_SCRIPT_ID: "s", BUNNY_DNS_ZONE_ID: "z" } },
  () => {
    test("returns empty when all settings are configured", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "a@b.com",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns payment-provider nag when payment_provider_setting is null", async () => {
      await withSetting(
        {
          payment_provider_setting: null,
          business_email: "a@b.com",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(1);
          expect(items[0].id).toBe("payment-provider");
          expect(items[0].href).toBeTruthy();
        },
      );
    });

    test("returns business-email nag when business_email is empty", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(1);
          expect(items[0].id).toBe("business-email");
          expect(items[0].href).toBeTruthy();
        },
      );
    });

    test("returns domain nag when domain is unset and bunny is enabled", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "a@b.com",
          custom_domain: "",
          bunny_subdomain: "",
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(1);
          expect(items[0].id).toBe("domain");
          expect(items[0].href).toBeTruthy();
        },
      );
    });

    test("returns all three nags when all are unset and bunny is enabled", async () => {
      await withSetting(
        {
          payment_provider_setting: null,
          business_email: "",
          custom_domain: "",
          bunny_subdomain: "",
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(3);
          expect(items[0].id).toBe("payment-provider");
          expect(items[0].href).toBeTruthy();
          expect(items[1].id).toBe("business-email");
          expect(items[1].href).toBeTruthy();
          expect(items[2].id).toBe("domain");
          expect(items[2].href).toBeTruthy();
        },
      );
    });

    test("returns no domain nag when custom_domain is set and bunny_subdomain is empty", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "a@b.com",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns no domain nag when custom_domain is empty and bunny_subdomain is set", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "a@b.com",
          custom_domain: "",
          bunny_subdomain: "myshop",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns no payment nag when payment_provider_setting is none", async () => {
      await withSetting(
        {
          payment_provider_setting: "none",
          business_email: "a@b.com",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns no payment nag when payment_provider_setting is square", async () => {
      await withSetting(
        {
          payment_provider_setting: "square",
          business_email: "a@b.com",
          custom_domain: "example.com",
          bunny_subdomain: "",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });
  },
);

describeWithEnv(
  "getSettingsNagItems with bunny disabled",
  { env: { BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined, BUNNY_DNS_ZONE_ID: undefined } },
  () => {
    test("suppresses domain nag when both bunny gates are disabled", async () => {
      await withSetting(
        {
          payment_provider_setting: "stripe",
          business_email: "a@b.com",
          custom_domain: "",
          bunny_subdomain: "",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });
  },
);
