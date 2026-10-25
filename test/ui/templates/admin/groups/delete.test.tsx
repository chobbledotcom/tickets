import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminGroupDeletePage } from "#templates/admin/groups/delete.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testGroup } from "#test-utils/factories.ts";

const group = testGroup({ id: 5, name: "Autumn Tours", slug: "autumn-tours" });

describe("adminGroupDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, confirm copy, note, and prompt", () => {
    const html = adminGroupDeletePage(group, OWNER_SESSION);

    assertStringIncludes(html, 'action="/admin/groups/5/delete"');
    assertStringIncludes(html, "<h1>Delete Group</h1>");
    assertStringIncludes(
      html,
      "Are you sure you want to delete the group <strong>Autumn Tours</strong> (autumn-tours)?",
    );
    assertStringIncludes(
      html,
      "<p>Listings in this group will not be deleted. They will be moved out of the group.</p>",
    );
    assertStringIncludes(
      html,
      "Type the group name &quot;Autumn Tours&quot; to confirm.",
    );
    assertStringIncludes(
      html,
      'name="confirm_identifier" placeholder="Autumn Tours" required',
    );
  });

  test("escapes the group name inside the confirm copy", () => {
    const tricky = testGroup({
      id: 6,
      name: "Fish & Chips <b>",
      slug: "fish-chips",
    });

    const html = adminGroupDeletePage(tricky, OWNER_SESSION);

    assertStringIncludes(html, "<strong>Fish &amp; Chips &lt;b&gt;</strong>");
    assert(!html.includes("Chips <b>"));
  });

  test("renders a non-dangerous submit button", () => {
    const html = adminGroupDeletePage(group, OWNER_SESSION);

    assert(!html.includes('<button class="danger" type="submit">'));
    assertStringIncludes(html, "/icons.svg#check");
    assertStringIncludes(html, "Delete Group");
  });

  test("renders a rejected-submit error", () => {
    const html = adminGroupDeletePage(
      group,
      OWNER_SESSION,
      "Group Name does not match.",
    );

    assertStringIncludes(html, "Group Name does not match.");
  });
});
