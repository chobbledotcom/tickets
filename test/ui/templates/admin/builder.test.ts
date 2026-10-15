import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import {
  adminBuilderPage,
  type BuiltSiteDisplay,
} from "#templates/admin/builder.tsx";
import { OWNER_SESSION } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("adminBuilderPage", () => {
  test("renders form fields", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    says(html, "Site name");
    says(html, "Database URL");
    says(html, "Database token");
    says(html, 'name="site_name"');
    says(html, 'name="db_url"');
    says(html, 'name="db_token"');
    says(html, "Build site");
  });

  test("renders empty state when no sites", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    says(html, "No sites have been built yet");
  });

  test("renders sites table with data", () => {
    const sites: BuiltSiteDisplay[] = [
      { created: "1 Jan 2026", name: "Alpha", siteUrl: "alpha.b-cdn.net" },
      { created: "2 Jan 2026", name: "Beta", siteUrl: "beta.b-cdn.net" },
    ];
    const html = adminBuilderPage(OWNER_SESSION, sites);
    says(html, "Alpha");
    says(html, "alpha.b-cdn.net");
    says(html, "Beta");
    says(html, "beta.b-cdn.net");
    says(html, "1 Jan 2026");
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
    says(html, 'href="https://test.b-cdn.net"');
    says(html, 'target="_blank"');
  });

  test("links a bare bunny.run address as a working b-cdn.net link", () => {
    const html = adminBuilderPage(OWNER_SESSION, [
      {
        created: "1 Jan 2026",
        name: "Bunny-run site",
        siteUrl: "childsite.bunny.run",
      },
    ]);
    says(html, 'href="https://childsite.b-cdn.net"');
    assert(!html.includes("bunny.run"));
  });

  test("renders error message", () => {
    const html = adminBuilderPage(OWNER_SESSION, [], "Something went wrong");
    says(html, "Something went wrong");
    says(html, 'class="error"');
  });

  test("renders success message", () => {
    const html = adminBuilderPage(
      OWNER_SESSION,
      [],
      undefined,
      "Site created!",
    );
    says(html, "Site created!");
    says(html, 'class="success"');
  });

  test("renders page title", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    says(html, "Site builder");
  });

  test("posts the create form to the builder route with its footer toggle", () => {
    const html = adminBuilderPage(OWNER_SESSION, []);
    says(html, 'action="/admin/builder"');
    says(html, 'id="builder-form"');
    // The assignment toggle posts 1, the value the route reads.
    const toggle = html.slice(
      html.indexOf('name="assignable"') - 80,
      html.indexOf('name="assignable"') + 80,
    );
    says(toggle, 'type="checkbox"');
    says(toggle, 'value="1"');
  });

  test("heads the sites table with one column per fact", () => {
    const html = adminBuilderPage(OWNER_SESSION, [
      { created: "1 Jan 2026", name: "Alpha", siteUrl: "alpha.b-cdn.net" },
    ]);
    says(html, "Name");
    says(html, "URL");
    says(html, "Built");
  });
});
