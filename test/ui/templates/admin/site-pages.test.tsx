import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";
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

    says(html, "<em>No pages yet.</em>");
    says(html, 'href="/admin/site/pages/new"');
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

    says(html, "Page moved");
    says(html, "<h2>Top-level pages</h2>");
    says(html, '<a href="/admin/site/pages/1/edit">First root</a>');
    says(html, "<code>/page/first</code>");
    says(html, 'action="/admin/site/pages/1/move-down"');
    assert(!html.includes('action="/admin/site/pages/1/move-up"'));
    says(html, 'action="/admin/site/pages/2/move-up"');
    assert(!html.includes('action="/admin/site/pages/2/move-down"'));
    says(html, "<h2>Nested pages</h2>");
    says(
      html,
      '<a href="/admin/site/pages/3/edit">Child page</a></td><td>First root</td>',
    );
    says(html, 'href="/admin/site/pages/3/delete"');
  });

  test("renders page names as plain text when the list is read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminSitePagesListPage(
      { nested: [], roots: [navPage(1, "First root", "first", 0)] },
      OWNER_SESSION,
    );

    says(html, "<span>First root</span>");
    assert(!html.includes('href="/admin/site/pages/new"'));
    assert(!html.includes('href="/admin/site/pages/1/edit"'));
    assert(!html.includes('href="/admin/site/pages/1/delete"'));
    assert(!html.includes('class="col-reorder"'));
  });

  test("renders the create form fields, action, error, and submit button", () => {
    const html = adminSitePageNewPage(OWNER_SESSION, "Slug is already used");

    says(html, 'action="/admin/site/pages"');
    says(html, "Slug is already used");
    says(html, 'name="name"');
    says(html, 'name="slug"');
    says(html, 'name="meta_title"');
    says(html, 'name="meta_description"');
    says(html, 'name="content"');
    says(html, "Create Page");
    assert(!html.includes('href="/page/"'));
  });

  test("prefills the edit panel and links to the saved public page", () => {
    const html = String(sitePageEditPanel(PAGE));

    says(html, 'action="/admin/site/pages/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Inside"/);
    expect(html).toMatch(/name="slug"[^>]*value="inside"/);
    says(html, 'href="/page/inside"');
    expect(html).toMatch(/name="meta_title"[^>]*value="Inside title"/);
    expect(html).toMatch(/name="meta_description"[^>]*value="A useful page"/);
    says(html, "Welcome **inside**.");
    says(html, "Save Changes");
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

    says(html, "<td>Listing</td><td>Summer show</td>");
    says(html, "<td>Group</td><td>Weekend bundle</td>");
    says(html, "<td>Page</td><td>Child page</td>");
    says(html, 'action="/admin/site/pages/7/items/listing/11/move-down"');
    assert(
      !html.includes('action="/admin/site/pages/7/items/listing/11/move-up"'),
    );
    says(html, 'action="/admin/site/pages/7/items/group/12/move-up"');
    says(html, 'action="/admin/site/pages/7/items/group/12/move-down"');
    assert(
      !html.includes('action="/admin/site/pages/7/items/page/13/move-down"'),
    );
    says(html, 'action="/admin/site/pages/7/items/page/13/remove"');
    says(html, "<h3>Add to this page</h3>");
    says(html, '<input name="item_type" type="hidden" value="listing">');
    says(html, '<option value="21">Winter show</option>');
    says(html, '<input name="item_type" type="hidden" value="page">');
    says(html, '<option value="22">About</option>');
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

    says(html, 'action="/admin/site/pages/7/delete"');
    says(html, "Page name does not match");
    says(
      html,
      "Type the page name &quot;Inside&quot; to confirm deletion. Its sub-pages become top-level pages.",
    );
    says(html, 'placeholder="Inside"');
    says(html, "Delete Page");
  });
});
