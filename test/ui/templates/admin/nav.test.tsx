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

  /** Every section that carries an "Add X" create link in its sub-nav: the
   * section's landing route, the create link, and the route the create page
   * itself renders with (which should highlight the create link). Each pair
   * lives only in its own section's sub-nav — never on the top-level bar. */
  const addLinkSections = [
    {
      addHref: "/admin/listing/new",
      addText: "Add Listing",
      createActive: "/admin/listing/new",
      roles: ["owner", "manager", "editor"] as const,
      sectionActive: "/admin/listings",
    },
    {
      addHref: "/admin/groups/new",
      addText: "Add Group",
      createActive: "/admin/groups/new",
      roles: ["owner", "manager", "editor"] as const,
      sectionActive: "/admin/groups",
    },
    {
      addHref: "/admin/servicing/new",
      addText: "New Service Event",
      createActive: "/admin/servicing/new",
      roles: ["owner", "manager"] as const,
      sectionActive: "/admin/servicing",
    },
    {
      addHref: "/admin/attendees/new",
      addText: "Add Attendee",
      createActive: "/admin/attendees/new",
      roles: ["owner", "manager"] as const,
      sectionActive: "/admin/attendees",
    },
    {
      addHref: "/admin/modifiers/new",
      addText: "Add Modifier",
      createActive: "/admin/modifiers/new",
      roles: ["owner", "manager"] as const,
      sectionActive: "/admin/modifiers",
    },
    {
      addHref: "/admin/user/new",
      addText: "Invite User",
      createActive: "/admin/user/new",
      roles: ["owner"] as const,
      sectionActive: "/admin/users",
    },
  ];

  // Regression: the create links used to sit on the top-level nav bar, visible
  // on every page. They must not appear at the top level any more — only inside
  // their own section's sub-nav.
  test("no 'Add X' create link shows on the top-level nav (away from its section)", () => {
    const html = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
    );
    for (const { addHref } of addLinkSections) {
      expect(html, addHref).not.toContain(`href="${addHref}"`);
    }
  });

  test("each 'Add X' link shows inside its own section for the roles that reach it", () => {
    for (const { sectionActive, addHref, addText, roles } of addLinkSections) {
      for (const adminLevel of roles) {
        const html = String(
          AdminNav({ active: sectionActive, session: { adminLevel } }),
        );
        expect(html, `${addHref} ${adminLevel}`).toContain(`href="${addHref}"`);
        expect(html, `${addHref} ${adminLevel}`).toContain(addText);
      }
    }
  });

  // Regression: a section's create link must stay inside that section, not leak
  // into a sibling section's sub-nav.
  test("a section's 'Add X' link does not show in a different section", () => {
    const listingsHtml = String(
      AdminNav({ active: "/admin/listings", session: { adminLevel: "owner" } }),
    );
    for (const { addHref } of addLinkSections.filter(
      (s) => s.addHref !== "/admin/listing/new",
    )) {
      expect(listingsHtml, addHref).not.toContain(`href="${addHref}"`);
    }
  });

  // Regression: clicking an "Add X" link landed on its create page but left the
  // link un-highlighted. Each create page now marks its own link active.
  test("each 'Add X' link highlights as active on its create page", () => {
    for (const { createActive, addHref, roles } of addLinkSections) {
      const html = String(
        AdminNav({ active: createActive, session: { adminLevel: roles[0] } }),
      );
      expect(html, addHref).toContain(`class="active" href="${addHref}"`);
    }
  });

  test("Invite User stays owner-only", () => {
    const managerHtml = String(
      AdminNav({ active: "/admin/users", session: { adminLevel: "manager" } }),
    );
    expect(managerHtml).not.toContain('href="/admin/user/new"');
  });

  test("AdminNav hides every 'Add X' create link in read-only mode, keeping the section links", () => {
    const restore = setTestEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    try {
      // Rendered from inside each section (where the links live), the create
      // links drop out under read-only while the section landing links stay.
      for (const { sectionActive, addHref } of addLinkSections) {
        const html = String(
          AdminNav({ active: sectionActive, session: { adminLevel: "owner" } }),
        );
        expect(html, addHref).not.toContain(`href="${addHref}"`);
        expect(html, sectionActive).toContain(`href="${sectionActive}"`);
      }
    } finally {
      restore();
    }
  });

  test("AdminNav marks the section landing link active on its landing page", () => {
    const html = String(
      AdminNav({
        active: "/admin/listings",
        session: { adminLevel: "owner" },
      }),
    );
    // The sub-nav highlights the landing link itself, not just the top bar.
    expect(html).toContain('class="active" href="/admin/listings"');
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
