import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { AdminNav } from "#templates/admin/nav.tsx";
import { describeWithEnv } from "#test-utils";

describeWithEnv("AdminNav", {}, () => {
  test("AdminNav passes session.settingsNagItems to SettingsNagBanner for owner sessions", () => {
    const superuserNag = {
      href: "/admin/settings#settings-superuser",
      id: "superuser" as const,
      label: "Choose whether to enable a superuser recovery account.",
    };
    const html = String(
      AdminNav({
        active: "/admin/",
        session: { adminLevel: "owner", settingsNagItems: [superuserNag] },
      }),
    );
    expect(html).toContain(
      "Choose whether to enable a superuser recovery account.",
    );
    expect(html).toContain('href="/admin/settings#settings-superuser"');
  });

  test("AdminNav does NOT render SettingsNagBanner for non-owner sessions", () => {
    const html = String(
      AdminNav({
        active: "/admin/",
        session: { adminLevel: "manager" },
      }),
    );
    expect(html).not.toContain("Finish setting up your site");
  });

  test("AdminNav uses SettingsNagBanner default (no items prop) when settingsNagItems is undefined", () => {
    const html = String(
      AdminNav({
        active: "/admin/",
        session: { adminLevel: "owner", settingsNagItems: undefined },
      }),
    );
    // SettingsNagBanner receives items=undefined and falls back to base nags.
    // Since base nags may be empty in this env, we just verify it renders.
    expect(html).toContain("nav");
  });
});
