import { expect } from "@std/expect";
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

    expect(html).toContain('action="/admin/groups/5/delete"');
    expect(html).toContain("<h1>Delete Group</h1>");
    expect(html).toContain(
      "Are you sure you want to delete the group <strong>Autumn Tours</strong> (autumn-tours)?",
    );
    expect(html).toContain(
      "<p>Listings in this group will not be deleted. They will be moved out of the group.</p>",
    );
    expect(html).toContain(
      "Type the group name &quot;Autumn Tours&quot; to confirm.",
    );
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Autumn Tours" required',
    );
  });

  test("renders a non-dangerous submit button", () => {
    const html = adminGroupDeletePage(group, OWNER_SESSION);

    expect(html).not.toContain('<button class="danger" type="submit">');
    expect(html).toContain("/icons.svg#check");
    expect(html).toContain("Delete Group");
  });

  test("renders a rejected-submit error", () => {
    const html = adminGroupDeletePage(
      group,
      OWNER_SESSION,
      "Group Name does not match.",
    );

    expect(html).toContain("Group Name does not match.");
  });
});
