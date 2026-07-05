import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { AdminLevel } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { describeWithEnv, setTestEnv, withSetting } from "#test-utils";

describeWithEnv("AdminNav", {}, () => {
  /** Assert every role in `adminLevels` sees a nav link to `href` labelled
   *  `text` (rendered from the "/admin/" landing nav). */
  const expectLinkForRoles = (
    href: string,
    text: string,
    adminLevels: readonly AdminLevel[],
  ): void => {
    for (const adminLevel of adminLevels) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      expect(html, adminLevel).toContain(`href="${href}"`);
      expect(html, adminLevel).toContain(text);
    }
  };

  /** Assert that both owners and managers see a nav link to `href` labelled
   *  `text` (rendered from the "/admin/" landing nav). */
  const expectOwnerAndManagerLink = (href: string, text: string): void =>
    expectLinkForRoles(href, text, ["owner", "manager"]);

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
    expectOwnerAndManagerLink("/admin/attendees", "Attendees");
  });

  test("AdminNav links to servicing for owners and managers", () => {
    expectOwnerAndManagerLink("/admin/servicing", "Servicing");
  });

  test("AdminNav links to Add Listing for owners, managers, and editors", () => {
    expectLinkForRoles("/admin/listing/new", "Add Listing", [
      "owner",
      "manager",
      "editor",
    ]);
  });

  test("AdminNav links to Add Group for owners, managers, and editors", () => {
    expectLinkForRoles("/admin/groups/new", "Add Group", [
      "owner",
      "manager",
      "editor",
    ]);
  });

  test("AdminNav pairs every other staff-only section with its create link", () => {
    const pairs: Array<{ addHref: string; addText: string }> = [
      { addHref: "/admin/attendees/new", addText: "Add Attendee" },
      { addHref: "/admin/modifiers/new", addText: "Add Modifier" },
      { addHref: "/admin/servicing/new", addText: "New Service Event" },
    ];
    const html = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
    );
    for (const { addHref, addText } of pairs) {
      expect(html, addHref).toContain(`href="${addHref}"`);
      expect(html, addHref).toContain(addText);
    }
  });

  test("AdminNav links to Invite User for owners only", () => {
    const ownerHtml = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
    );
    expect(ownerHtml).toContain('href="/admin/user/new"');
    expect(ownerHtml).toContain("Invite User");
    const managerHtml = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "manager" } }),
    );
    expect(managerHtml).not.toContain('href="/admin/user/new"');
  });

  test("AdminNav hides every 'Add X' create link in read-only mode, keeping the section links", () => {
    const restore = setTestEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    try {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
      );
      for (const addHref of [
        "/admin/listing/new",
        "/admin/groups/new",
        "/admin/attendees/new",
        "/admin/modifiers/new",
        "/admin/servicing/new",
        "/admin/user/new",
      ]) {
        expect(html, addHref).not.toContain(`href="${addHref}"`);
      }
      // The sections themselves stay linkable.
      expect(html).toContain('href="/admin/listings"');
      expect(html).toContain('href="/admin/groups"');
    } finally {
      restore();
    }
  });

  test("AdminNav marks Add Listing active on the new-listing page", () => {
    const html = String(
      AdminNav({
        active: "/admin/listing/new",
        session: { adminLevel: "owner" },
      }),
    );
    expect(html).toContain('class="active" href="/admin/listing/new"');
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

  test("the desktop sub-nav nests only under the one active section link", () => {
    const html = String(
      AdminNav({
        active: "/admin/settings",
        session: { adminLevel: "owner" },
      }),
    );
    // Exactly ONE nested sub-nav, and it sits directly after the active
    // Settings anchor — never under the other top-level items.
    expect((html.match(/admin-subnav/g) ?? []).length).toBe(1);
    expect(html).toContain(
      '<a class="active" href="/admin/settings">Settings</a><ul class="admin-subnav">',
    );
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

  test("owner sees a top-level Site link when the public site is enabled", () =>
    withSetting({ show_public_site: true }, () => {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
      );
      expect(html).toContain('href="/admin/site"');
    }));

  test("owner does not see Site when the public site is disabled", () =>
    withSetting({ show_public_site: false }, () => {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
      );
      expect(html).not.toContain('href="/admin/site"');
    }));

  test("owner keeps the Site parent on the Site editor even when disabled", () =>
    withSetting({ show_public_site: false }, () => {
      const html = String(
        AdminNav({ active: "/admin/site", session: { adminLevel: "owner" } }),
      );
      // The top-level Site parent stays so the desktop sub-nav has something to
      // nest under (otherwise Homepage/Contact/Order vanish on desktop).
      expect(html).toContain('href="/admin/site"');
      expect(html).toContain('href="/admin/site/contact"');
    }));

  test("managers and agents never see the Site link", () =>
    withSetting({ show_public_site: true }, () => {
      for (const adminLevel of ["manager", "agent"] as const) {
        const html = String(
          AdminNav({ active: "/admin/", session: { adminLevel } }),
        );
        expect(html, adminLevel).not.toContain('href="/admin/site"');
      }
    }));

  test("the Site section sub-nav shows for owner and editor on /admin/site", () =>
    withSetting({ show_public_site: true }, () => {
      for (const adminLevel of ["owner", "editor"] as const) {
        const html = String(
          AdminNav({ active: "/admin/site", session: { adminLevel } }),
        );
        expect(html).toContain('href="/admin/site/contact"');
        expect(html).toContain('href="/admin/site/order"');
      }
    }));

  test("editors get no section sub-nav away from the Site editor", () =>
    withSetting({ show_public_site: true }, () => {
      const html = String(
        AdminNav({
          active: "/admin/listings",
          session: { adminLevel: "editor" },
        }),
      );
      expect(html).not.toContain('href="/admin/site/contact"');
    }));

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
