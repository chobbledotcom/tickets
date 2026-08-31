import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { addPageItem } from "#db/site-page-items.ts";
import { sitePages } from "#db/site-pages.ts";
import {
  expectHtmlResponse,
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
      expect(html).toContain("No pages yet");
    });

    test("GET new renders the create form with a slug field but no public link", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      expect(html).toContain("Create Page");
      // The content textarea is a markdown field (preview enabled).
      expect(html).toContain("data-markdown-preview");
      // The slug is entered on create, but the page has no live page yet — so no
      // "Public link" (which would 404 or point at a duplicate/reserved slug).
      expect(html).toContain('name="slug"');
      expect(html).not.toContain("Public link");
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
      expect(html).not.toContain("No pages yet");
      // The first row can only move down; the last row can only move up.
      expect(html).toContain(`${BASE}/${first.id}/move-down`);
      expect(html).not.toContain(`${BASE}/${first.id}/move-up`);
      expect(html).toContain(`${BASE}/${last.id}/move-up`);
      expect(html).not.toContain(`${BASE}/${last.id}/move-down`);
    });

    test("list shows root and nested pages with reorder arrows", async () => {
      await create("root-a");
      await create("root-b");
      const parent = await findPage("root-a");
      await create("child-a");
      const child = await findPage("child-a");
      await addPageItem(parent.id, "page", child.id);
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      expect(html).toContain("Top-level pages");
      expect(html).toContain("Nested pages");
      expect(html).toContain("/page/root-a");
      // Two roots ⇒ both arrows render (first has "down", second has "up").
      expect(html).toContain("move-down");
      expect(html).toContain("move-up");
    });

    test("removes the order column in read-only mode", async () => {
      await create("read-only-page");
      using _env = withEnv({
        READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      });

      const html = await expectHtmlResponse(await adminGet(BASE), 200);

      expect(html).not.toContain('class="col-reorder"');
      expect(html).not.toContain("move-down");
      expect(html).not.toContain("move-up");
    });
  });
});
