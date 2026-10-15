import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminGroupsPage } from "#templates/admin/groups/list.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testGroup } from "#test-utils/factories.ts";
import type { AdminSession } from "#types";

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

    assertStringIncludes(html, "<th>Name</th><th>Slug</th>");
    assertStringIncludes(
      html,
      '<a href="/admin/groups/7">Family &lt;script&gt;</a>',
    );
    assertStringIncludes(html, "family-&quot;weekend&quot;");
    assert(
      !html.includes("Family <script>"),
      "the value should not contain the searched item",
    );
    expect(html.indexOf("Family &lt;script&gt;")).toBeLessThan(
      html.indexOf(">Summer<"),
    );
    assertStringIncludes(html, 'href="/admin/guide#packages"');
  });

  test("links an editor to the group and hides the forbidden staff guide", () => {
    // The group page opens on the first tab its viewer can see, so an editor
    // following this link lands on Edit.
    const html = adminGroupsPage([GROUP], EDITOR_SESSION);

    assertStringIncludes(
      html,
      '<a href="/admin/groups/7">Family &lt;script&gt;</a>',
    );
    assert(
      !html.includes('href="/admin/guide#packages"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Packages guide"),
      "the value should not contain the searched item",
    );
  });

  test("marks the groups list as the section the page belongs to", () => {
    const html = adminGroupsPage([GROUP], OWNER_SESSION);

    assertStringIncludes(html, '<a class="active" href="/admin/groups">');
  });

  test("renders the empty state without an empty table", () => {
    const html = adminGroupsPage([], OWNER_SESSION, "Group deleted.");

    assertStringIncludes(html, "Group deleted.");
    assertStringIncludes(html, "No groups configured.");
    assert(
      !html.includes("<table"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, 'href="/admin/guide#packages"');
  });
});
