import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("adminSeedsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the intro, both number boxes, and the create button", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    expectIncludesAll(html, [
      "Fill the empty site with example listings",
      'name="listing_count"',
      'name="attendees_per_listing"',
      "Create example data",
      'action="/admin/seeds"',
    ]);
  });

  test("carries the page title and the create button's icon", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    expectIncludesAll(html, ["<title>Example data</title>", "#plus"]);
  });

  test("offers the way back to the dashboard", () => {
    assertStringIncludes(adminSeedsPage(OWNER_SESSION), 'href="/admin"');
  });
});
