import { expect } from "@std/expect";
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
    expect(html).toContain("Fill the empty site with example listings");
    expect(html).toContain('name="listing_count"');
    expect(html).toContain('name="attendees_per_listing"');
    expect(html).toContain("Create example data");
    expect(html).toContain('action="/admin/seeds"');
  });

  test("carries the page title and the create button's icon", () => {
    const html = adminSeedsPage(OWNER_SESSION);
    expect(html).toContain("<title>Example data</title>");
    expect(html).toContain("#plus");
  });

  test("offers the way back to the dashboard", () => {
    expect(adminSeedsPage(OWNER_SESSION)).toContain('href="/admin"');
  });
});
