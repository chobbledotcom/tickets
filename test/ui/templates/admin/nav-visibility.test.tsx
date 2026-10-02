import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { AdminNav } from "#templates/admin/nav.tsx";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { withStorageDisabled, withStorageEnabled } from "#test-utils/mocks.ts";
import {
  featureSetting,
  useSetting,
  withSetting,
} from "#test-utils/settings.ts";

/** The first desktop sub-nav's HTML, for asserting a link sits inside it. */
const subNav = (html: string): string => {
  const start = html.indexOf('class="admin-subnav"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</ul>", start));
};

/** Which sections and links each role, feature flag, and host setting makes
 * visible. The structural tests (highlighting, sub-nav nesting, create-link
 * machinery) live in nav.test.tsx. */
describeWithEnv("AdminNav visibility", {}, () => {
  useSetting(featureSetting("money", "site"));

  test("AdminNav hides optional features when they are disabled", async () => {
    await withSetting(featureSetting(), () => {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
      );
      for (const href of [
        "/admin/servicing",
        "/admin/modifiers",
        "/admin/ledger",
      ]) {
        expect(html, href).not.toContain(`href="${href}"`);
      }
      expect(html).toContain('href="/admin/attendees"');
    });
  });

  test("AdminNav hides feature links inside Users and Settings", async () => {
    await withSetting(featureSetting(), () => {
      const users = String(
        AdminNav({ active: "/admin/users", session: { adminLevel: "owner" } }),
      );
      const settings = String(
        AdminNav({
          active: "/admin/settings",
          session: { adminLevel: "owner" },
        }),
      );
      expect(users).not.toContain('href="/admin/api-keys"');
      expect(settings).not.toContain('href="/admin/attributes"');
      expect(settings).not.toContain('href="/admin/logistics"');
      expect(settings).not.toContain('href="/admin/questions"');
    });
  });

  test("AdminNav shows Money to owners but not managers", () => {
    const ownerHtml = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
    );
    expect(ownerHtml).toContain('href="/admin/ledger"');
    expect(ownerHtml).toContain("Money");
    expect(ownerHtml).not.toContain("Money history");
    const managerHtml = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "manager" } }),
    );
    expect(managerHtml).not.toContain('href="/admin/ledger"');
  });

  test("owner sees a top-level Site link when Site is enabled", () => {
    const html = String(
      AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
    );
    expect(html).toContain('href="/admin/site"');
  });

  test("owner does not see Site when Site is disabled", () =>
    withSetting(featureSetting(), () => {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel: "owner" } }),
      );
      expect(html).not.toContain('href="/admin/site"');
    }));

  test("Site routes stay out of the nav while Site is disabled", () =>
    withSetting(featureSetting(), () => {
      for (const active of ["/admin/site", "/admin/site/contact"]) {
        const html = String(
          AdminNav({ active, session: { adminLevel: "owner" } }),
        );
        expect(html, active).not.toContain('href="/admin/site"');
        expect(html, active).not.toContain('href="/admin/site/contact"');
      }
    }));

  test("managers and agents never see the Site link", () => {
    for (const adminLevel of ["manager", "agent"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      expect(html, adminLevel).not.toContain('href="/admin/site"');
    }
  });

  test("the Site section sub-nav shows for owner and editor on /admin/site", () => {
    for (const adminLevel of ["owner", "editor"] as const) {
      const html = String(
        AdminNav({ active: "/admin/site", session: { adminLevel } }),
      );
      expect(html).toContain('href="/admin/site/contact"');
      expect(html).toContain('href="/admin/site/order"');
    }
  });

  test("editors get no section sub-nav away from the Site editor", () => {
    const html = String(
      AdminNav({
        active: "/admin/listings",
        session: { adminLevel: "editor" },
      }),
    );
    expect(html).not.toContain('href="/admin/site/contact"');
  });

  test("the Images section sub-nav offers an Add link when storage is enabled", () =>
    withStorageEnabled(() => {
      const html = String(
        AdminNav({ active: "/admin/images", session: { adminLevel: "owner" } }),
      );
      expect(html).toContain('href="/admin/images/new"');
      const sub = subNav(html);
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

  test("Guide stays hidden from editors, scanners, and agents", () => {
    for (const adminLevel of ["editor", "scanner", "agent"] as const) {
      const html = String(
        AdminNav({ active: "/admin/", session: { adminLevel } }),
      );
      expect(html, adminLevel).not.toContain('href="/admin/guide"');
    }
  });

  test("Support sits in the Guide sub-nav for owners when the host offers it", () => {
    using _env = withEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const html = String(
      AdminNav({ active: "/admin/guide", session: { adminLevel: "owner" } }),
    );
    const sub = subNav(html);
    expect(sub).toContain('href="/admin/support"');
    expect(sub).toContain("Support");
  });

  test("Support is hidden from managers even when the host offers it", () => {
    using _env = withEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const html = String(
      AdminNav({ active: "/admin/guide", session: { adminLevel: "manager" } }),
    );
    expect(html).toContain('href="/admin/guide"');
    expect(html).not.toContain('href="/admin/support"');
  });

  test("Support is hidden when the host has no admin contact address", () => {
    using _env = withEnv({ ADMIN_EMAIL_ADDRESS: undefined });
    const html = String(
      AdminNav({ active: "/admin/guide", session: { adminLevel: "owner" } }),
    );
    expect(html).not.toContain('href="/admin/support"');
    expect(html).toContain('href="/admin/guide"');
  });

  test("Support is gone from the Settings sub-nav", () => {
    using _env = withEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const html = String(
      AdminNav({
        active: "/admin/settings",
        session: { adminLevel: "owner" },
      }),
    );
    expect(html).not.toContain('href="/admin/support"');
  });

  test("the Support page highlights Guide and its own sub-nav link", () => {
    using _env = withEnv({ ADMIN_EMAIL_ADDRESS: "admin@example.com" });
    const html = String(
      AdminNav({ active: "/admin/support", session: { adminLevel: "owner" } }),
    );
    expect(html).toContain('class="active" href="/admin/guide"');
    expect(html).toContain('class="active" href="/admin/support"');
  });
});
