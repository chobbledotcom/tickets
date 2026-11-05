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
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";
import type { SitePage, SitePageNavRow } from "#types";

const PAGE: SitePage = {
  content: "Welcome **inside**.",
  hidden: false,
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
): SitePageNavRow => ({ hidden: false, id, name, slug, sort_order: sortOrder });

describe("site page templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders the empty page list without either table", () => {
    const html = adminSitePagesListPage(
      { nested: [], roots: [] },
      OWNER_SESSION,
    );

    expectIncludesAll(html, [
      "<em>No pages yet.</em>",
      'href="/admin/site/pages/new"',
    ]);
    assert(!html.includes("Top-level pages"));
    assert(!html.includes("Nested pages"));
    assert(!html.includes("<table"));
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

    expectIncludesAll(html, [
      "Page moved",
      "<h2>Top-level pages</h2>",
      '<a href="/admin/site/pages/1/edit">First root</a>',
      "<code>/page/first</code>",
      'action="/admin/site/pages/1/move-down"',
    ]);
    assert(!html.includes('action="/admin/site/pages/1/move-up"'));
    assertStringIncludes(html, 'action="/admin/site/pages/2/move-up"');
    assert(!html.includes('action="/admin/site/pages/2/move-down"'));
    expectIncludesAll(html, [
      "<h2>Nested pages</h2>",
      '<a href="/admin/site/pages/3/edit">Child page</a></td><td>First root</td>',
      'href="/admin/site/pages/3/delete"',
    ]);
  });

  test("renders page names as plain text when the list is read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminSitePagesListPage(
      { nested: [], roots: [navPage(1, "First root", "first", 0)] },
      OWNER_SESSION,
    );

    assertStringIncludes(html, "<span>First root</span>");
    assert(!html.includes('href="/admin/site/pages/new"'));
    assert(!html.includes('href="/admin/site/pages/1/edit"'));
    assert(!html.includes('href="/admin/site/pages/1/delete"'));
    assert(!html.includes('class="col-reorder"'));
  });

  test("renders the create form fields, action, error, and submit button", () => {
    const html = adminSitePageNewPage(OWNER_SESSION, "Slug is already used");

    expectIncludesAll(html, [
      'action="/admin/site/pages"',
      "Slug is already used",
      'name="name"',
      'name="slug"',
      'name="meta_title"',
      'name="meta_description"',
      'name="content"',
      "Create Page",
    ]);
    assert(!html.includes('href="/page/"'));
  });

  test("prefills the edit panel and links to the saved public page", () => {
    const html = String(sitePageEditPanel(PAGE));

    assertStringIncludes(html, 'action="/admin/site/pages/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Inside"/);
    expect(html).toMatch(/name="slug"[^>]*value="inside"/);
    assertStringIncludes(html, 'href="/page/inside"');
    expect(html).toMatch(/name="meta_title"[^>]*value="Inside title"/);
    expect(html).toMatch(/name="meta_description"[^>]*value="A useful page"/);
    expectIncludesAll(html, ["Welcome **inside**.", "Save Changes"]);
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

    expectIncludesAll(html, [
      "<td>Listing</td><td>Summer show</td>",
      "<td>Group</td><td>Weekend bundle</td>",
      "<td>Page</td><td>Child page</td>",
      'action="/admin/site/pages/7/items/listing/11/move-down"',
    ]);
    assert(
      !html.includes('action="/admin/site/pages/7/items/listing/11/move-up"'),
    );
    expectIncludesAll(html, [
      'action="/admin/site/pages/7/items/group/12/move-up"',
      'action="/admin/site/pages/7/items/group/12/move-down"',
    ]);
    assert(
      !html.includes('action="/admin/site/pages/7/items/page/13/move-down"'),
    );
    expectIncludesAll(html, [
      'action="/admin/site/pages/7/items/page/13/remove"',
      "<h3>Add to this page</h3>",
      '<input name="item_type" type="hidden" value="listing">',
      '<option value="21">Winter show</option>',
      '<input name="item_type" type="hidden" value="page">',
      '<option value="22">About</option>',
    ]);
    assert(
      !html.includes('<input name="item_type" type="hidden" value="group">'),
    );
  });

  test("renders the page delete prompt and submitted error", () => {
    const html = adminSitePageDeletePage(
      PAGE,
      OWNER_SESSION,
      "Page name does not match",
    );

    expectIncludesAll(html, [
      'action="/admin/site/pages/7/delete"',
      "Page name does not match",
      "Type the page name &quot;Inside&quot; to confirm deletion. Its sub-pages become top-level pages.",
      'placeholder="Inside"',
      "Delete Page",
    ]);
  });
});
