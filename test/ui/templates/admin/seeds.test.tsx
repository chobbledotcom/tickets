import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

describe("adminSeedsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the intro, both number boxes, and the create button", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    assertStringIncludes(html, "Fill the empty site with example listings");
    assertStringIncludes(html, 'name="listing_count"');
    assertStringIncludes(html, 'name="attendees_per_listing"');
    assertStringIncludes(html, "Create example data");
    assertStringIncludes(html, 'action="/admin/seeds"');
  });

  test("carries the page title and the create button's icon", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    assertStringIncludes(html, "<title>Example data</title>");
    assertStringIncludes(html, "#plus");
  });

  test("offers the way back to the dashboard", () => {
    assertStringIncludes(adminSeedsPage(OWNER_SESSION), 'href="/admin"');
  });
});
