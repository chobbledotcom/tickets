import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { addPageItem } from "#db/site-page-items.ts";
import { sitePages, sitePagesTable } from "#db/site-pages.ts";
import {
  expectHtmlResponse,
  expectIncludesAll,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { adminGet } from "#test-utils/session.ts";
import { BASE, create, findPage } from "./helpers.ts";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  describe("list + new", () => {
    testRequiresAuth(BASE);

    test("empty state renders the no-pages message", async () => {
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      assertStringIncludes(html, "No pages yet");
    });

    test("GET new renders the create form with a slug field but no public link", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      expectIncludesAll(html, [
        "Create Page",
        // The content textarea is a markdown field (preview enabled).
        "data-markdown-preview",
        // The slug is entered on create, but the page has no live page yet — so no
        // "Public link" (which would 404 or point at a duplicate/reserved slug).
        'name="slug"',
      ]);
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
      assertStringIncludes(html, `${BASE}/${first.id}/move-down`);
      assert(!html.includes(`${BASE}/${first.id}/move-up`));
      assertStringIncludes(html, `${BASE}/${last.id}/move-up`);
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
      expectIncludesAll(html, [
        "Top-level pages",
        "Nested pages",
        "/page/root-a",
        // Two roots ⇒ both arrows render (first has "down", second has "up").
        "move-down",
        "move-up",
      ]);
    });

    test("lists the pages from their nav columns, without a full-row read", async () => {
      await create("nav-only");
      using _fullRead = stub(sitePagesTable.read, "many", () =>
        Promise.reject(new Error("The list page must not read full rows")),
      );

      const html = await expectHtmlResponse(await adminGet(BASE), 200);

      assertStringIncludes(html, "/page/nav-only");
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
