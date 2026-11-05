import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminBuilderPage,
  type BuiltSiteDisplay,
} from "#templates/admin/builder.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("adminBuilderPage", () => {
  test("renders form fields", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    expectIncludesAll(html, [
      "Site name",
      "Database URL",
      "Database token",
      'name="site_name"',
      'name="db_url"',
      'name="db_token"',
      "Build site",
    ]);
  });

  test("renders empty state when no sites", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    assertStringIncludes(html, "No sites have been built yet");
  });

  test("renders sites table with data", () => {
    const sites: BuiltSiteDisplay[] = [
      { created: "1 Jan 2026", name: "Alpha", siteUrl: "alpha.b-cdn.net" },
      { created: "2 Jan 2026", name: "Beta", siteUrl: "beta.b-cdn.net" },
    ];
    const html = adminBuilderPage(OWNER_SESSION, sites);
    expectIncludesAll(html, [
      "Alpha",
      "alpha.b-cdn.net",
      "Beta",
      "beta.b-cdn.net",
      "1 Jan 2026",
    ]);
    assert(!html.includes("No sites have been built yet"));
  });

  test("renders sites as clickable links", () => {
    const sites: BuiltSiteDisplay[] = [
      {
        created: "1 Jan 2026",
        name: "Test",
        siteUrl: "https://test.b-cdn.net",
      },
    ];
    const html = adminBuilderPage(OWNER_SESSION, sites);
    expectIncludesAll(html, [
      'href="https://test.b-cdn.net"',
      'target="_blank"',
    ]);
  });

  test("links a bare bunny.run address as a working b-cdn.net link", () => {
    const html = adminBuilderPage(OWNER_SESSION, [
      {
        created: "1 Jan 2026",
        name: "Bunny-run site",
        siteUrl: "childsite.bunny.run",
      },
    ]);
    assertStringIncludes(html, 'href="https://childsite.b-cdn.net"');
    assert(!html.includes("bunny.run"));
  });

  test("renders error message", () => {
    const html = adminBuilderPage(OWNER_SESSION, [], "Something went wrong");
    expectIncludesAll(html, ["Something went wrong", 'class="error"']);
  });

  test("renders success message", () => {
    const html = adminBuilderPage(
      OWNER_SESSION,
      [],
      undefined,
      "Site created!",
    );
    expectIncludesAll(html, ["Site created!", 'class="success"']);
  });

  test("renders page title", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    assertStringIncludes(html, "Site builder");
  });

  test("posts the create form to the builder route with its footer toggle", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    expectIncludesAll(html, ['action="/admin/builder"', 'id="builder-form"']);
    // The assignment toggle posts 1, the value the route reads.
    const toggle = html.slice(
      html.indexOf('name="assignable"') - 80,
      html.indexOf('name="assignable"') + 80,
    );
    expectIncludesAll(toggle, ['type="checkbox"', 'value="1"']);
  });

  test("heads the sites table with one column per fact", () => {
    const html = adminBuilderPage(OWNER_SESSION, [
      { created: "1 Jan 2026", name: "Alpha", siteUrl: "alpha.b-cdn.net" },
    ]);
    expectIncludesAll(html, ["Name", "URL", "Built"]);
  });
});
