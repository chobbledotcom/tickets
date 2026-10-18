import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  contentEntityEditPanel,
  contentGuideFooter,
} from "#templates/admin/site-content.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

describe("contentEntityEditPanel", () => {
  setupAdminPageTest();

  test("renders one entity's edit form posting to its update route", () => {
    type Post = { id: number; name: string };
    const editForm = {
      render: (values: { name: string }) =>
        `<input name="name" value="${values.name}">`,
    };
    const panel = contentEntityEditPanel<Post, { name: string }>(
      "/admin/site/news",
      editForm,
      (post) => ({ name: post.name }),
    );

    const html = String(panel({ id: 17, name: "Launch &amp; Learn" }));
    assertStringIncludes(html, 'action="/admin/site/news/17/edit"');
    assertStringIncludes(html, 'value="Launch &amp; Learn"');
    assertStringIncludes(html, "Save Changes");
  });

  test("the site content guide footer links staff and hides from editors", () => {
    const owner = String(contentGuideFooter("built-sites", "owner"));
    assertStringIncludes(owner, 'href="/admin/guide#built-sites"');
    assertStringIncludes(owner, "Guide: pages, news &amp; images");
    // Editors cannot open the staff-only guide, so the footer renders nothing
    // rather than a link that 403s.
    expect(String(contentGuideFooter("built-sites", "editor"))).toBe("");
  });
});
