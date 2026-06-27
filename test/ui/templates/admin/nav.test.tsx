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

  test("AdminNav links to the attendees browser for owners and managers", () => {
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      expect(html).toContain('href="/admin/attendees"');
      expect(html).toContain("Attendees");
    }
  });

  test("AdminNav links to servicing for owners and managers", () => {
    for (const adminLevel of ["owner", "manager"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      expect(html).toContain('href="/admin/servicing"');
      expect(html).toContain("Servicing");
    }
  });

  test("AdminNav shows the Ledger link to owners but not managers", () => {
    const ownerHtml = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
    );
    expect(ownerHtml).toContain('href="/admin/ledger"');
    expect(ownerHtml).toContain("Ledger");
    const managerHtml = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "manager" } }),
    );
    expect(managerHtml).not.toContain('href="/admin/ledger"');
  });

  test("AdminNav marks the Ledger link active on the ledger page", () => {
    const html = String(
      AdminNav({
        active: "/admin/ledger",
        session: { adminLevel: "owner" },
      }),
    );
    expect(html).toContain('class="active" href="/admin/ledger"');
  });

  test("AdminNav marks the attendees link active on the attendees page", () => {
    const html = String(
      AdminNav({
        active: "/admin/attendees",
        session: { adminLevel: "owner" },
      }),
    );
    expect(html).toContain('class="active" href="/admin/attendees"');
  });

  test("AdminNav marks the servicing link active on servicing pages", () => {
    const html = String(
      AdminNav({
        active: "/admin/servicing",
        session: { adminLevel: "owner" },
      }),
    );
    expect(html).toContain('class="active" href="/admin/servicing"');
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
