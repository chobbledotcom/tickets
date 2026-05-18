import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getSettingsNagItems } from "#shared/settings-nags.ts";
import { describeWithEnv, withSetting } from "#test-utils";

describeWithEnv(
  "getSettingsNagItems",
  { env: { BUNNY_API_KEY: "k", BUNNY_DNS_ZONE_ID: "z", BUNNY_SCRIPT_ID: "s" } },
  () => {
    test("returns empty when all settings are configured", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "example.com",
          payment_provider_setting: "stripe",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns payment-provider nag when payment_provider_setting is null", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "example.com",
          payment_provider_setting: null,
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(1);
          expect(items[0]!.id).toBe("payment-provider");
          expect(items[0]!.href).toBeTruthy();
        },
      );
    });

    test("returns business-email nag when business_email is empty", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "example.com",
          payment_provider_setting: "stripe",
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(1);
          expect(items[0]!.id).toBe("business-email");
          expect(items[0]!.href).toBeTruthy();
        },
      );
    });

    test("returns domain nag when domain is unset and bunny is enabled", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "",
          payment_provider_setting: "stripe",
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(1);
          expect(items[0]!.id).toBe("domain");
          expect(items[0]!.href).toBeTruthy();
        },
      );
    });

    test("returns all three nags when all are unset and bunny is enabled", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "",
          payment_provider_setting: null,
        },
        () => {
          const items = getSettingsNagItems();
          expect(items).toHaveLength(3);
          expect(items[0]!.id).toBe("payment-provider");
          expect(items[0]!.href).toBeTruthy();
          expect(items[1]!.id).toBe("business-email");
          expect(items[1]!.href).toBeTruthy();
          expect(items[2]!.id).toBe("domain");
          expect(items[2]!.href).toBeTruthy();
        },
      );
    });

    test("returns no domain nag when custom_domain is set and bunny_subdomain is empty", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "example.com",
          payment_provider_setting: "stripe",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns no domain nag when custom_domain is empty and bunny_subdomain is set", async () => {
      await withSetting(
        {
          bunny_subdomain: "myshop",
          business_email: "a@b.com",
          custom_domain: "",
          payment_provider_setting: "stripe",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns no payment nag when payment_provider_setting is none", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "example.com",
          payment_provider_setting: "none",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });

    test("returns no payment nag when payment_provider_setting is square", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "example.com",
          payment_provider_setting: "square",
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
  {
    env: {
      BUNNY_API_KEY: undefined,
      BUNNY_DNS_ZONE_ID: undefined,
      BUNNY_SCRIPT_ID: undefined,
    },
  },
  () => {
    test("suppresses domain nag when both bunny gates are disabled", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "a@b.com",
          custom_domain: "",
          payment_provider_setting: "stripe",
        },
        () => {
          expect(getSettingsNagItems()).toEqual([]);
        },
      );
    });
  },
);
