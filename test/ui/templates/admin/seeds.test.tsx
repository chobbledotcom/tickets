import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminSeedsPage } from "#templates/admin/seeds.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("adminSeedsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the intro, both number boxes, and the create button", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    says(html, "Fill the empty site with example listings");
    says(html, 'name="listing_count"');
    says(html, 'name="attendees_per_listing"');
    says(html, "Create example data");
    says(html, 'action="/admin/seeds"');
  });

  test("carries the page title and the create button's icon", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    says(html, "<title>Example data</title>");
    says(html, "#plus");
  });

  test("offers the way back to the dashboard", () => {
    says(adminSeedsPage(OWNER_SESSION), 'href="/admin"');
  });
});
