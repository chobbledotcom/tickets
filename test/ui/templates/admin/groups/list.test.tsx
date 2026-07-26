import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AdminSession } from "#shared/types.ts";
import { adminGroupsPage } from "#templates/admin/groups/list.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testGroup } from "#test-utils/factories.ts";

const EDITOR_SESSION: AdminSession = { adminLevel: "editor" };
const GROUP = testGroup({
  id: 7,
  name: "Family <script>",
  slug: 'family-"weekend"',
});

describe("admin groups list template", () => {
  beforeAll(setupAdminPageTest);

  test("renders populated rows with safe staff detail links and the guide", () => {
    const second = testGroup({ id: 8, name: "Summer", slug: "summer" });
    const html = adminGroupsPage([GROUP, second], OWNER_SESSION);

    expect(html).toContain("<th>Name</th><th>Slug</th>");
    expect(html).toContain(
      '<a href="/admin/groups/7">Family &lt;script&gt;</a>',
    );
    expect(html).toContain("family-&quot;weekend&quot;");
    expect(html).not.toContain("Family <script>");
    expect(html.indexOf("Family &lt;script&gt;")).toBeLessThan(
      html.indexOf(">Summer<"),
    );
    expect(html).toContain('href="/admin/guide#packages"');
  });

  test("links editors straight to editing and hides the forbidden staff guide", () => {
    const html = adminGroupsPage([GROUP], EDITOR_SESSION);

    expect(html).toContain(
      '<a href="/admin/groups/7/edit">Family &lt;script&gt;</a>',
    );
    expect(html).not.toContain('href="/admin/groups/7"');
    expect(html).not.toContain('href="/admin/guide#packages"');
    expect(html).not.toContain("Packages guide");
  });

  test("renders the empty state without an empty table", () => {
    const html = adminGroupsPage([], OWNER_SESSION, "Group deleted.");

    expect(html).toContain("Group deleted.");
    expect(html).toContain("No groups configured.");
    expect(html).not.toContain("<table");
    expect(html).toContain('href="/admin/guide#packages"');
  });
});
