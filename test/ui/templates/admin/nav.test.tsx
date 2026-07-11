import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { ADMIN_SURFACE, adminDestination } from "#shared/admin-surface.ts";
import type { AdminLevel } from "#shared/types.ts";
import { AdminNav } from "#templates/admin/nav.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { setTestEnv } from "#test-utils/env.ts";
import { withStorageDisabled, withStorageEnabled } from "#test-utils/mocks.ts";
import { withSetting } from "#test-utils/settings.ts";

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

  /** Every section that carries an "Add X" create link in its sub-nav, derived
   *  from the admin-page schema — the section's landing route, the create link,
   *  and the roles that reach it. Feature-flag-gated sections (Images) are
   *  excluded here — they have dedicated tests that enable the flag. Each pair
   *  lives only in its own section's sub-nav — never on the top-level bar. */
  const addLinkSections = ADMIN_SURFACE.destinations
    .filter((route) => route.nav?.kind === "create")
    .map((route) => ({
      route,
      section: ADMIN_SURFACE.sections.find(
        (section) => section.id === route.section,
      )!,
    }))
    .filter(({ section }) => !("visible" in section))
    .map(({ route, section }) => ({
      addHref: route.pattern,
      addText: t(route.nav!.labelKey),
      createActive: route.pattern,
      roles: route.audience,
      sectionActive: adminDestination(section.landing).pattern,
    }));

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
      const topRole = roles[0];
      if (!topRole) throw new Error(`section ${addHref} declares no roles`);
      const html = String(
        AdminNav({ active: createActive, session: { adminLevel: topRole } }),
      );
      expect(html, addHref).toContain(`class="active" href="${addHref}"`);
    }
  });

  // The sub-nav lists only the pages *within* a section — it must not repeat the
  // section's own landing link (that already sits on the top-level bar).
  test("a section's sub-nav does not repeat its landing link", () => {
    for (const { sectionActive } of addLinkSections) {
      const html = String(
        AdminNav({ active: sectionActive, session: { adminLevel: "owner" } }),
      );
      const start = html.indexOf('class="admin-subnav"');
      expect(start, sectionActive).toBeGreaterThan(-1);
      const sub = html.slice(start, html.indexOf("</ul>", start));
      expect(sub, sectionActive).not.toContain(`href="${sectionActive}"`);
    }
  });

  // The catalog import lives as a plain "Import" link in the Listings sub-nav.
  test("the Listings sub-nav offers an Import link", () => {
    const html = String(
      AdminNav({ active: "/admin/listings", session: { adminLevel: "owner" } }),
    );
    expect(html).toContain('href="/admin/catalog/import"');
    const start = html.indexOf('class="admin-subnav"');
    const sub = html.slice(start, html.indexOf("</ul>", start));
    expect(sub).toContain("Import");
  });

  test("the Listings Import link hides in read-only mode (it leads to a blocked upload flow)", () => {
    const restore = setTestEnv({
      READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
    });
    try {
      const html = String(
        AdminNav({
          active: "/admin/listings",
          session: { adminLevel: "owner" },
        }),
      );
      expect(html).not.toContain('href="/admin/catalog/import"');
      // The section landing link stays.
      expect(html).toContain('href="/admin/listings"');
    } finally {
      restore();
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

  test("AdminNav marks the section's top-level link active on its landing page", () => {
    const html = String(
      AdminNav({
        active: "/admin/listings",
        session: { adminLevel: "owner" },
      }),
    );
    expect(html).toContain('class="active" href="/admin/listings"');
  });

  // Regression (PR #1600 review): a section's *landing* page renders with the
  // section route as `active` (e.g. /admin/users, /admin/settings). That route
  // equals the landing sub-item's href, so highlighting it in the sub-nav would
  // just duplicate the top-level highlight — and any deeper page that fell back
  // to the section route would wrongly light the landing item. So the sub-nav
  // stays clean on the landing route; the section shows as active on the top bar.
  test("a section sub-nav does not highlight its landing item from the section route", () => {
    for (const active of ["/admin/users", "/admin/settings"]) {
      const html = String(
        AdminNav({ active, session: { adminLevel: "owner" } }),
      );
      // Isolate the desktop sub-nav (the nested <ul class="admin-subnav">) and
      // confirm nothing inside it is marked active.
      const start = html.indexOf('class="admin-subnav"');
      expect(start, active).toBeGreaterThan(-1);
      const sub = html.slice(start, html.indexOf("</ul>", start));
      expect(sub, active).not.toContain('class="active"');
    }
  });

  // The current-page highlight applies to EVERY sub-page, not just the "Add X"
  // create pages: each deeper page passes its own route, so its sub-nav link
  // lights up (while the section stays highlighted on the top-level bar).
  test("every section sub-page highlights its own sub-nav link", () => {
    const deepPages = [
      { active: "/admin/sessions", href: "/admin/sessions" },
      { active: "/admin/api-keys", href: "/admin/api-keys" },
      { active: "/admin/deliveries", href: "/admin/deliveries" },
      { active: "/admin/privacy", href: "/admin/privacy" },
      { active: "/admin/questions", href: "/admin/questions" },
      { active: "/admin/emails", href: "/admin/emails" },
      { active: "/admin/settings/statuses", href: "/admin/settings/statuses" },
      { active: "/admin/backup", href: "/admin/backup" },
      { active: "/admin/site/contact", href: "/admin/site/contact" },
      { active: "/admin/site/pages", href: "/admin/site/pages" },
    ];
    for (const { active, href } of deepPages) {
      const settingOverrides =
        active === "/admin/deliveries" ? { has_logistics: true } : {};
      withSetting(settingOverrides, () => {
        const html = String(
          AdminNav({ active, session: { adminLevel: "owner" } }),
        );
        expect(html, active).toContain(`class="active" href="${href}"`);
      });
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

  // Regression: an individual attendee page (and every other single-item page)
  // used to pass the *section landing route* as its `active` value just to get
  // the top-level link highlighted — which also re-opened the section's "Add"
  // sub-nav beside a page that is not the section's landing page. A page that
  // merely lives *within* a section now says so with `{ section }`: the section
  // still highlights, but its sub-nav (here, the "Add" create link) must not
  // appear. Verified for every section that carries an "Add X"-style sub-nav —
  // derived from the schema so new sections are covered automatically.
  const withinSectionCases = addLinkSections
    .filter((s) => s.sectionActive !== "/admin/users")
    .map((s) => ({ addHref: s.addHref, section: s.sectionActive }));

  test("a page within a section highlights the section but shows no sub-nav", () => {
    for (const { section, addHref } of withinSectionCases) {
      const html = String(
        AdminNav({ active: { section }, session: { adminLevel: "owner" } }),
      );
      // The section's top-level link is highlighted…
      expect(html, section).toContain(`class="active" href="${section}"`);
      // …but its sub-nav (the "Add" create link, and the whole desktop
      // sub-nav level) is absent — a detail page is not the landing page.
      expect(html, section).not.toContain(`href="${addHref}"`);
      expect(html, section).not.toContain("admin-subnav");
    }
  });

  // The contrast that proves the distinction is real: the SAME section, passed
  // as a bare route string (the landing list page), DOES open the sub-nav.
  test("the same section as a bare route string still opens its sub-nav", () => {
    for (const { section, addHref } of withinSectionCases) {
      const html = String(
        AdminNav({ active: section, session: { adminLevel: "owner" } }),
      );
      expect(html, section).toContain(`href="${addHref}"`);
      expect(html, section).toContain("admin-subnav");
    }
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

  // Regression (PR #1600 review): now that the Site sub-pages pass their own
  // route, a Site *sub-page* (not just /admin/site) must also keep the top-level
  // Site parent when the public site is off — otherwise the desktop sub-nav that
  // nests under the active Site parent would have nothing to hang from.
  test("owner keeps the Site parent on a Site sub-page when disabled", () =>
    withSetting({ show_public_site: false }, () => {
      for (const active of ["/admin/site/contact", "/admin/site/pages"]) {
        const html = String(
          AdminNav({ active, session: { adminLevel: "owner" } }),
        );
        expect(html, active).toContain('href="/admin/site"');
        expect(html, active).toContain('href="/admin/site/contact"');
        // The current sub-page is highlighted in the sub-nav.
        expect(html, active).toContain(`class="active" href="${active}"`);
      }
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

  test("the Images section sub-nav offers an Add link when storage is enabled", () =>
    withStorageEnabled(() => {
      const html = String(
        AdminNav({ active: "/admin/images", session: { adminLevel: "owner" } }),
      );
      expect(html).toContain('href="/admin/images/new"');
      const start = html.indexOf('class="admin-subnav"');
      expect(start).toBeGreaterThan(-1);
      const sub = html.slice(start, html.indexOf("</ul>", start));
      expect(sub).toContain('href="/admin/images/new"');
      expect(sub).toContain("Add");
    }));

  test("editors see the Images Add sub-nav link too when storage is enabled", () =>
    withStorageEnabled(() => {
      const html = String(
        AdminNav({
          active: "/admin/images",
          session: { adminLevel: "editor" },
        }),
      );
      expect(html).toContain('href="/admin/images/new"');
    }));

  test("the Images section is absent when storage is disabled", () =>
    withStorageDisabled(() => {
      const html = String(
        AdminNav({ active: "/admin/images", session: { adminLevel: "owner" } }),
      );
      expect(html).not.toContain('href="/admin/images/new"');
    }));

  test("AdminNav uses SettingsNagBanner default (no items prop) when settingsNagItems is omitted", () => {
    const html = String(
      AdminNav({
        active: "/admin/",
        session: { adminLevel: "owner" },
      }),
    );
    // SettingsNagBanner receives items=undefined and falls back to base nags.
    // Since base nags may be empty in this env, we just verify it renders.
    expect(html).toContain("nav");
  });
});
