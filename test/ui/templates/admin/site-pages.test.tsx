import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import type { SitePage, SitePageNavRow } from "#shared/types.ts";
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

    expect(html).toContain("<em>No pages yet.</em>");
    expect(html).toContain('href="/admin/site/pages/new"');
    expect(html).not.toContain("Top-level pages");
    expect(html).not.toContain("Nested pages");
    expect(html).not.toContain("<table");
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

    expect(html).toContain("Page moved");
    expect(html).toContain("<h2>Top-level pages</h2>");
    expect(html).toContain('<a href="/admin/site/pages/1/edit">First root</a>');
    expect(html).toContain("<code>/page/first</code>");
    expect(html).toContain('action="/admin/site/pages/1/move-down"');
    expect(html).not.toContain('action="/admin/site/pages/1/move-up"');
    expect(html).toContain('action="/admin/site/pages/2/move-up"');
    expect(html).not.toContain('action="/admin/site/pages/2/move-down"');
    expect(html).toContain("<h2>Nested pages</h2>");
    expect(html).toContain(
      '<a href="/admin/site/pages/3/edit">Child page</a></td><td>First root</td>',
    );
    expect(html).toContain('href="/admin/site/pages/3/delete"');
  });

  test("renders page names as plain text when the list is read-only", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = adminSitePagesListPage(
      { nested: [], roots: [navPage(1, "First root", "first", 0)] },
      OWNER_SESSION,
    );

    expect(html).toContain("<span>First root</span>");
    expect(html).not.toContain('href="/admin/site/pages/new"');
    expect(html).not.toContain('href="/admin/site/pages/1/edit"');
    expect(html).not.toContain('href="/admin/site/pages/1/delete"');
    expect(html).not.toContain('class="col-reorder"');
  });

  test("renders the create form fields, action, error, and submit button", () => {
    const html = adminSitePageNewPage(OWNER_SESSION, "Slug is already used");

    expect(html).toContain('action="/admin/site/pages"');
    expect(html).toContain("Slug is already used");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="slug"');
    expect(html).toContain('name="meta_title"');
    expect(html).toContain('name="meta_description"');
    expect(html).toContain('name="content"');
    expect(html).toContain("Create Page");
    expect(html).not.toContain('href="/page/"');
  });

  test("prefills the edit panel and links to the saved public page", () => {
    const html = String(sitePageEditPanel(PAGE));

    expect(html).toContain('action="/admin/site/pages/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Inside"/);
    expect(html).toMatch(/name="slug"[^>]*value="inside"/);
    expect(html).toContain('href="/page/inside"');
    expect(html).toMatch(/name="meta_title"[^>]*value="Inside title"/);
    expect(html).toMatch(/name="meta_description"[^>]*value="A useful page"/);
    expect(html).toContain("Welcome **inside**.");
    expect(html).toContain("Save Changes");
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

    expect(html).toContain("<td>Listing</td><td>Summer show</td>");
    expect(html).toContain("<td>Group</td><td>Weekend bundle</td>");
    expect(html).toContain("<td>Page</td><td>Child page</td>");
    expect(html).toContain(
      'action="/admin/site/pages/7/items/listing/11/move-down"',
    );
    expect(html).not.toContain(
      'action="/admin/site/pages/7/items/listing/11/move-up"',
    );
    expect(html).toContain(
      'action="/admin/site/pages/7/items/group/12/move-up"',
    );
    expect(html).toContain(
      'action="/admin/site/pages/7/items/group/12/move-down"',
    );
    expect(html).not.toContain(
      'action="/admin/site/pages/7/items/page/13/move-down"',
    );
    expect(html).toContain('action="/admin/site/pages/7/items/page/13/remove"');
    expect(html).toContain("<h3>Add to this page</h3>");
    expect(html).toContain(
      '<input name="item_type" type="hidden" value="listing">',
    );
    expect(html).toContain('<option value="21">Winter show</option>');
    expect(html).toContain(
      '<input name="item_type" type="hidden" value="page">',
    );
    expect(html).toContain('<option value="22">About</option>');
    expect(html).not.toContain(
      '<input name="item_type" type="hidden" value="group">',
    );
  });

  test("renders the page delete prompt and submitted error", () => {
    const html = adminSitePageDeletePage(
      PAGE,
      OWNER_SESSION,
      "Page name does not match",
    );

    expect(html).toContain('action="/admin/site/pages/7/delete"');
    expect(html).toContain("Page name does not match");
    expect(html).toContain(
      "Type the page name &quot;Inside&quot; to confirm deletion. Its sub-pages become top-level pages.",
    );
    expect(html).toContain('placeholder="Inside"');
    expect(html).toContain("Delete Page");
  });
});
