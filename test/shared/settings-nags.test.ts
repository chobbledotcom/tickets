import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settings } from "#shared/db/settings.ts";
import {
  getSettingsNagItems,
  getSettingsNagItemsForOwner,
} from "#shared/settings-nags.ts";
import { getSuperuserState } from "#shared/superuser.ts";
import { describeWithEnv, setTestEnv, withSetting } from "#test-utils";

// ---------------------------------------------------------------------------
// Backward-compatible sync base nags
// ---------------------------------------------------------------------------

describeWithEnv(
  "getSettingsNagItems",
  { env: { BUNNY_API_KEY: "k", BUNNY_DNS_ZONE_ID: "z", BUNNY_SCRIPT_ID: "s" } },
  () => {
    test("getSettingsNagItems() returns only base nags synchronously (no superuser)", async () => {
      await withSetting(
        {
          bunny_subdomain: "",
          business_email: "",
          custom_domain: "",
          payment_provider_setting: null,
        },
        () => {
          const items = getSettingsNagItems();
          expect(items.some((i) => i.id === "payment-provider")).toBe(true);
          expect(items.some((i) => i.id === "business-email")).toBe(true);
          expect(items.some((i) => i.id === "domain")).toBe(true);
          expect(items.some((i) => i.id === "superuser")).toBe(false);
        },
      );
    });

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
          expect(items[1]!.id).toBe("business-email");
          expect(items[2]!.id).toBe("domain");
        },
      );
    });
  },
);

// ---------------------------------------------------------------------------
// getSettingsNagItemsForOwner() — async owner nags
// ---------------------------------------------------------------------------

describeWithEnv("getSettingsNagItemsForOwner", { db: true }, () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
  });

  test("returns base nags plus superuser nag when env is set, choice empty, user nonexistent", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "" });
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(true);
    const superuserItem = items.find((i) => i.id === "superuser");
    expect(superuserItem).toEqual({
      href: "/admin/settings#settings-superuser",
      id: "superuser",
      label: "Choose whether to enable a superuser recovery account.",
    });
    expect(items[items.length - 1]!.id).toBe("superuser");
    // Base nags may or may not appear depending on DB setup state
    expect(items.some((i) => i.id === "payment-provider")).toBe(true);
  });

  test("does NOT show superuser nag when ADMIN_EMAIL_ADDRESS is unset", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(false);
  });

  test("does NOT show superuser nag when ADMIN_EMAIL_ADDRESS is invalid email", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "not-an-email" });
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(false);
  });

  test("does NOT show superuser nag when derived username is invalid (dots)", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "john.doe@example.com" });
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(false);
  });

  test("does NOT show superuser nag when superuser_choice is 'self-managed'", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "self-managed" });
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(false);
  });

  test("does NOT show superuser nag when superuser_choice is 'enabled'", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "enabled" });
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(false);
  });

  test("does NOT show superuser nag when derived username exists AND is activated (has wrapped_data_key)", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "" });
    const { createUser } = await import("#shared/db/users.ts");
    const { hashPassword } = await import("#shared/crypto/hashing.ts");
    const pw = await hashPassword("test");
    await createUser("admin", pw, "some-wrapped-key", "owner");
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(false);
  });

  test("shows superuser nag when derived username exists but is NOT activated (null wrapped_data_key)", async () => {
    restoreEnv = setTestEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    settings.setForTest({ superuser_choice: "" });
    const { createUser } = await import("#shared/db/users.ts");
    await createUser("admin", "", null, "owner");
    const items = await getSettingsNagItemsForOwner();
    expect(items.some((i) => i.id === "superuser")).toBe(true);
  });

  test("never includes superuser nag when getSuperuserState returns unavailable", async () => {
    const stateStub = stub(
      getSuperuserState as unknown as Record<string, unknown>,
      "getSuperuserState",
      () => Promise.resolve({ available: false, reason: "missing-env" }),
    );
    try {
      const items = await getSettingsNagItemsForOwner();
      expect(items.some((i) => i.id === "superuser")).toBe(false);
    } finally {
      stateStub.restore();
    }
  });
});
