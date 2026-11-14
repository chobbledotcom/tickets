import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  contentEntityEditPanel,
  contentGuideFooter,
} from "#templates/admin/site-content.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("contentEntityEditPanel", () => {
  setupAdminPageTest();

  test("renders one entity's edit form posting to its update route", () => {
    type Post = { id: number; name: string };
    const editForm = {
      render: (values: Record<string, string>) =>
        `<input name="name" value="${values.name}">`,
    };
    const panel = contentEntityEditPanel<Post, { name: string }>(
      "/admin/site/news",
      editForm,
      (post) => ({ name: post.name }),
    );

    const html = String(panel({ id: 17, name: "Launch &amp; Learn" }));
    expectIncludesAll(html, [
      'action="/admin/site/news/17/edit"',
      'value="Launch &amp; Learn"',
      "Save Changes",
    ]);
  });

  test("a rejected edit shows the message over the submitted values", () => {
    const panel = contentEntityEditPanel(
      "/admin/site/news",
      { render: (values: Record<string, string>) => `<i>${values.name}</i>` },
      (post: { id: number; name: string }) => ({ name: post.name }),
    );

    const html = String(
      panel(
        { id: 17, name: "Stored" },
        { error: "Slug is reserved", values: { name: "Submitted" } },
      ),
    );
    expectIncludesAll(html, ["Slug is reserved", "<i>Submitted</i>"]);
    expect(html).not.toContain("Stored");
  });

  test("the site content guide footer links staff and hides from editors", () => {
    const owner = String(contentGuideFooter("built-sites", "owner"));
    expectIncludesAll(owner, [
      'href="/admin/guide#built-sites"',
      "Guide: pages, news &amp; images",
    ]);
    // Editors cannot open the staff-only guide, so the footer renders nothing
    // rather than a link that 403s.
    expect(String(contentGuideFooter("built-sites", "editor"))).toBe("");
  });
});
