import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#crypto/sealed.ts";
import {
  adminSitePageDeletePage,
  adminSitePageNewPage,
  adminSitePagesListPage,
  sitePageEditPanel,
  sitePageItemsPanel,
} from "#templates/admin/site-pages.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
import type { SitePage, SitePageNavRow } from "#types";

const PAGE: SitePage = {
  content: "Welcome **inside**.",
  id: 7,
  meta_description: "A useful page",
  meta_title: "Inside title",
  name: "Inside",
  slug: "inside",
  slug_index: "site-page-index" as BlindIndex,
  sort_order: 0,
};

const navPage = (
  id: number,
  name: string,
  slug: string,
  sortOrder: number,
): SitePageNavRow => ({ id, name, slug, sort_order: sortOrder });

describe("site page templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders the empty page list without either table", () => {
    const html = adminSitePagesListPage(
      { nested: [], roots: [] },
      OWNER_SESSION,
    );

    assertStringIncludes(html, "<em>No pages yet.</em>");
    assertStringIncludes(html, 'href="/admin/site/pages/new"');
    assert(
      !html.includes("Top-level pages"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Nested pages"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("<table"),
      "the value should not contain the searched item",
    );
  });

  test("renders root ordering and the separate nested-page table", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = adminSitePagesListPage(
      {
        nested: [
          {
            page: navPage(3, "Child page", "child", 0),
            parentName: "First root",
          },
        ],
        roots: [
          navPage(1, "First root", "first", 0),
          navPage(2, "Second root", "second", 1),
        ],
      },
      OWNER_SESSION,
      "Page moved",
    );

    assertStringIncludes(html, "Page moved");
    assertStringIncludes(html, "<h2>Top-level pages</h2>");
    assertStringIncludes(
      html,
      '<a href="/admin/site/pages/1/edit">First root</a>',
    );
    assertStringIncludes(html, "<code>/page/first</code>");
    assertStringIncludes(html, 'action="/admin/site/pages/1/move-down"');
    assert(
      !html.includes('action="/admin/site/pages/1/move-up"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, 'action="/admin/site/pages/2/move-up"');
    assert(
      !html.includes('action="/admin/site/pages/2/move-down"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "<h2>Nested pages</h2>");
    assertStringIncludes(
      html,
      '<a href="/admin/site/pages/3/edit">Child page</a></td><td>First root</td>',
    );
    assertStringIncludes(html, 'href="/admin/site/pages/3/delete"');
  });

  test("renders page names as plain text when the list is read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminSitePagesListPage(
      { nested: [], roots: [navPage(1, "First root", "first", 0)] },
      OWNER_SESSION,
    );

    assertStringIncludes(html, "<span>First root</span>");
    assert(
      !html.includes('href="/admin/site/pages/new"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('href="/admin/site/pages/1/edit"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('href="/admin/site/pages/1/delete"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('class="col-reorder"'),
      "the value should not contain the searched item",
    );
  });

  test("renders the create form fields, action, error, and submit button", () => {
    const html = adminSitePageNewPage(OWNER_SESSION, "Slug is already used");

    assertStringIncludes(html, 'action="/admin/site/pages"');
    assertStringIncludes(html, "Slug is already used");
    assertStringIncludes(html, 'name="name"');
    assertStringIncludes(html, 'name="slug"');
    assertStringIncludes(html, 'name="meta_title"');
    assertStringIncludes(html, 'name="meta_description"');
    assertStringIncludes(html, 'name="content"');
    assertStringIncludes(html, "Create Page");
    assert(
      !html.includes('href="/page/"'),
      "the value should not contain the searched item",
    );
  });

  test("prefills the edit panel and links to the saved public page", () => {
    const html = String(sitePageEditPanel(PAGE));

    assertStringIncludes(html, 'action="/admin/site/pages/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Inside"/);
    expect(html).toMatch(/name="slug"[^>]*value="inside"/);
    assertStringIncludes(html, 'href="/page/inside"');
    expect(html).toMatch(/name="meta_title"[^>]*value="Inside title"/);
    expect(html).toMatch(/name="meta_description"[^>]*value="A useful page"/);
    assertStringIncludes(html, "Welcome **inside**.");
    assertStringIncludes(html, "Save Changes");
  });

  test("shows only the no-items note when nothing exists or can be added", () => {
    const html = String(
      sitePageItemsPanel({
        groupOptions: [],
        items: [],
        listingOptions: [],
        page: PAGE,
        pageOptions: [],
      }),
    );

    expect(html).toBe(
      "<p><em>This page has no listings, groups, or sub-pages yet.</em></p>",
    );
  });

  test("renders item moves, removals, and only non-empty add pickers", () => {
    const html = String(
      sitePageItemsPanel({
        groupOptions: [],
        items: [
          { id: 11, label: "Summer show", type: "listing" },
          { id: 12, label: "Weekend bundle", type: "group" },
          { id: 13, label: "Child page", type: "page" },
        ],
        listingOptions: [{ label: "Winter show", value: "21" }],
        page: PAGE,
        pageOptions: [{ label: "About", value: "22" }],
      }),
    );

    assertStringIncludes(html, "<td>Listing</td><td>Summer show</td>");
    assertStringIncludes(html, "<td>Group</td><td>Weekend bundle</td>");
    assertStringIncludes(html, "<td>Page</td><td>Child page</td>");
    assertStringIncludes(
      html,
      'action="/admin/site/pages/7/items/listing/11/move-down"',
    );
    assert(
      !html.includes('action="/admin/site/pages/7/items/listing/11/move-up"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      'action="/admin/site/pages/7/items/group/12/move-up"',
    );
    assertStringIncludes(
      html,
      'action="/admin/site/pages/7/items/group/12/move-down"',
    );
    assert(
      !html.includes('action="/admin/site/pages/7/items/page/13/move-down"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      html,
      'action="/admin/site/pages/7/items/page/13/remove"',
    );
    assertStringIncludes(html, "<h3>Add to this page</h3>");
    assertStringIncludes(
      html,
      '<input name="item_type" type="hidden" value="listing">',
    );
    assertStringIncludes(html, '<option value="21">Winter show</option>');
    assertStringIncludes(
      html,
      '<input name="item_type" type="hidden" value="page">',
    );
    assertStringIncludes(html, '<option value="22">About</option>');
    assert(
      !html.includes('<input name="item_type" type="hidden" value="group">'),
      "the value should not contain the searched item",
    );
  });

  test("renders the page delete prompt and submitted error", () => {
    const html = adminSitePageDeletePage(
      PAGE,
      OWNER_SESSION,
      "Page name does not match",
    );

    assertStringIncludes(html, 'action="/admin/site/pages/7/delete"');
    assertStringIncludes(html, "Page name does not match");
    assertStringIncludes(
      html,
      "Type the page name &quot;Inside&quot; to confirm deletion. Its sub-pages become top-level pages.",
    );
    assertStringIncludes(html, 'placeholder="Inside"');
    assertStringIncludes(html, "Delete Page");
  });
});
