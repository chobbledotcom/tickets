import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AdminSession } from "#shared/types.ts";
import {
  adminBuilderPage,
  type BuiltSiteDisplay,
} from "#templates/admin/builder.tsx";

const SESSION: AdminSession = {
  adminLevel: "owner",
};

describe("adminBuilderPage", () => {
  test("renders form fields", () => {
    const html = adminBuilderPage(SESSION, []);
    expect(html).toContain("Site Name");
    expect(html).toContain("Database URL");
    expect(html).toContain("Database Token");
    expect(html).toContain('name="site_name"');
    expect(html).toContain('name="db_url"');
    expect(html).toContain('name="db_token"');
    expect(html).toContain("Build Site");
  });

  test("renders empty state when no sites", () => {
    const html = adminBuilderPage(SESSION, []);
    expect(html).toContain("No sites have been built yet");
  });

  test("renders sites table with data", () => {
    const sites: BuiltSiteDisplay[] = [
      { created: "1 Jan 2026", name: "Alpha", siteUrl: "alpha.b-cdn.net" },
      { created: "2 Jan 2026", name: "Beta", siteUrl: "beta.b-cdn.net" },
    ];
    const html = adminBuilderPage(SESSION, sites);
    expect(html).toContain("Alpha");
    expect(html).toContain("alpha.b-cdn.net");
    expect(html).toContain("Beta");
    expect(html).toContain("beta.b-cdn.net");
    expect(html).toContain("1 Jan 2026");
    expect(html).not.toContain("No sites have been built yet");
  });

  test("renders sites as clickable links", () => {
    const sites: BuiltSiteDisplay[] = [
      {
        created: "1 Jan 2026",
        name: "Test",
        siteUrl: "https://test.b-cdn.net",
      },
    ];
    const html = adminBuilderPage(SESSION, sites);
    expect(html).toContain('href="https://test.b-cdn.net"');
    expect(html).toContain('target="_blank"');
  });

  test("renders error message", () => {
    const html = adminBuilderPage(SESSION, [], "Something went wrong");
    expect(html).toContain("Something went wrong");
    expect(html).toContain('class="error"');
  });

  test("renders success message", () => {
    const html = adminBuilderPage(SESSION, [], undefined, "Site created!");
    expect(html).toContain("Site created!");
    expect(html).toContain('class="success"');
  });

  test("renders page title", () => {
    const html = adminBuilderPage(SESSION, []);
    expect(html).toContain("Site Builder");
  });
});
