import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminGroupDeletePage } from "#templates/admin/groups/delete.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { testGroup } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

const group = testGroup({ id: 5, name: "Autumn Tours", slug: "autumn-tours" });

describe("adminGroupDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, confirm copy, note, and prompt", () => {
    const html = adminGroupDeletePage(group, OWNER_SESSION);

    says(html, 'action="/admin/groups/5/delete"');
    says(html, "<h1>Delete Group</h1>");
    says(
      html,
      "Are you sure you want to delete the group <strong>Autumn Tours</strong> (autumn-tours)?",
    );
    says(
      html,
      "<p>Listings in this group will not be deleted. They will be moved out of the group.</p>",
    );
    says(html, "Type the group name &quot;Autumn Tours&quot; to confirm.");
    says(html, 'name="confirm_identifier" placeholder="Autumn Tours" required');
  });

  test("escapes the group name inside the confirm copy", () => {
    const tricky = testGroup({
      id: 6,
      name: "Fish & Chips <b>",
      slug: "fish-chips",
    });

    const html = adminGroupDeletePage(tricky, OWNER_SESSION);

    says(html, "<strong>Fish &amp; Chips &lt;b&gt;</strong>");
    assert(!html.includes("Chips <b>"));
  });

  test("renders a non-dangerous submit button", () => {
    const html = adminGroupDeletePage(group, OWNER_SESSION);

    assert(!html.includes('<button class="danger" type="submit">'));
    says(html, "/icons.svg#check");
    says(html, "Delete Group");
  });

  test("renders a rejected-submit error", () => {
    const html = adminGroupDeletePage(
      group,
      OWNER_SESSION,
      "Group Name does not match.",
    );

    says(html, "Group Name does not match.");
  });
});
