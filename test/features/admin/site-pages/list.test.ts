import { assert } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { addPageItem } from "#db/site-page-items.ts";
import { sitePages } from "#db/site-pages.ts";
import {
  expectHtmlResponse,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { says } from "#test-utils/says.ts";
import { adminGet } from "#test-utils/session.ts";
import { BASE, create, findPage } from "./helpers.ts";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  describe("list + new", () => {
    testRequiresAuth(BASE);

    test("empty state renders the no-pages message", async () => {
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      says(html, "No pages yet");
    });

    test("GET new renders the create form with a slug field but no public link", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      says(html, "Create Page");
      // The content textarea is a markdown field (preview enabled).
      says(html, "data-markdown-preview");
      // The slug is entered on create, but the page has no live page yet — so no
      // "Public link" (which would 404 or point at a duplicate/reserved slug).
      says(html, 'name="slug"');
      assert(!html.includes("Public link"));
    });

    test("reorder arrows appear only where a move is possible", async () => {
      await create("a1");
      await create("a2");
      await create("a3");
      const rows = await sitePages.getAll();
      const first = rows[0]!;
      const last = rows[2]!;
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      // Roots exist, so the all-empty message must not show.
      assert(!html.includes("No pages yet"));
      // The first row can only move down; the last row can only move up.
      says(html, `${BASE}/${first.id}/move-down`);
      assert(!html.includes(`${BASE}/${first.id}/move-up`));
      says(html, `${BASE}/${last.id}/move-up`);
      assert(!html.includes(`${BASE}/${last.id}/move-down`));
    });

    test("list shows root and nested pages with reorder arrows", async () => {
      await create("root-a");
      await create("root-b");
      const parent = await findPage("root-a");
      await create("child-a");
      const child = await findPage("child-a");
      await addPageItem(parent.id, "page", child.id);
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      says(html, "Top-level pages");
      says(html, "Nested pages");
      says(html, "/page/root-a");
      // Two roots ⇒ both arrows render (first has "down", second has "up").
      says(html, "move-down");
      says(html, "move-up");
    });

    test("removes the order column in read-only mode", async () => {
      await create("read-only-page");
      using _env = withEnv({
        READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      });

      const html = await expectHtmlResponse(await adminGet(BASE), 200);

      assert(!html.includes('class="col-reorder"'));
      assert(!html.includes("move-down"));
      assert(!html.includes("move-up"));
    });
  });
});
