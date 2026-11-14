// Direct pins on the site-page input layer: the mapped write for a create and
// an update, and the parent plan an update runs inside its transaction.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { addPageItem, getAllPageItems } from "#db/site-page-items.ts";
import { t } from "#i18n";
import {
  planParentChange,
  toPageWrite,
} from "#routes/admin/api-site-pages-input.ts";
import { validateSlug } from "#shared/slug.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import type { SitePage } from "#types";

/** The page edges as parent and child id pairs. */
const pageEdges = async (): Promise<[number, number][]> =>
  (await getAllPageItems())
    .filter((item) => item.item_type === "page")
    .map((item) => [item.page_id, item.item_id]);

/** Plan a parent change, expect it to pass, and run its step in a write
 *  transaction. Answers what the step answers. */
const runParentPlan = async (page: SitePage, raw: unknown) => {
  const plan = await planParentChange(page, raw);
  if (!plan.ok) throw new Error(`parent plan refused: ${plan.error}`);
  return withTransaction(plan.value);
};

describeWithEnv("Site page input layer", { db: true }, () => {
  describe("toPageWrite", () => {
    test("a create with only a name and slug takes the form's defaults", () => {
      expect(toPageWrite({ name: "About", slug: "about" }, null)).toEqual({
        ok: true,
        value: {
          content: "",
          hidden: false,
          metaDescription: "",
          metaTitle: "",
          name: "About",
          slug: "about",
        },
      });
    });

    test("content keeps its first-line indent and the meta fields trim", () => {
      const write = toPageWrite(
        {
          content: "\n\n    code block  \n",
          meta_description: "  Short  ",
          meta_title: "  Title  ",
          name: "Docs",
          slug: "docs",
        },
        null,
      );
      expect(write).toEqual({
        ok: true,
        value: {
          content: "    code block",
          hidden: false,
          metaDescription: "Short",
          metaTitle: "Title",
          name: "Docs",
          slug: "docs",
        },
      });
    });

    test("an update clears stored text that the body sends as empty", async () => {
      const page = await createTestSitePage("stored-text", {
        content: "Stored body",
        metaDescription: "Stored description",
        metaTitle: "Stored title",
        name: "Stored",
      });
      expect(
        toPageWrite(
          { content: "", meta_description: "", meta_title: "" },
          page,
        ),
      ).toEqual({
        ok: true,
        value: {
          content: "",
          hidden: false,
          metaDescription: "",
          metaTitle: "",
          name: "Stored",
          slug: "stored-text",
        },
      });
    });

    test("an update refuses an empty slug instead of keeping the stored one", async () => {
      const page = await createTestSitePage("kept-slug", { name: "Kept" });
      expect(toPageWrite({ slug: "" }, page)).toEqual({
        error: validateSlug(""),
        ok: false,
      });
    });
  });

  describe("planParentChange", () => {
    test("moving a page to the top level drops only its own edge", async () => {
      const firstParent = await createTestSitePage("first-parent");
      const firstChild = await createTestSitePage("first-child");
      const secondParent = await createTestSitePage("second-parent");
      const moved = await createTestSitePage("moved-child");
      await addPageItem(firstParent.id, "page", firstChild.id);
      await addPageItem(secondParent.id, "page", moved.id);

      expect(await runParentPlan(moved, null)).toBe(true);
      expect(await pageEdges()).toEqual([[firstParent.id, firstChild.id]]);
    });

    test("re-sending the current parent writes nothing and answers true", async () => {
      const parent = await createTestSitePage("same-parent");
      const child = await createTestSitePage("same-child");
      await addPageItem(parent.id, "page", child.id);

      expect(await runParentPlan(child, parent.id)).toBe(true);
      expect(await pageEdges()).toEqual([[parent.id, child.id]]);
    });

    test("moves a page under another page", async () => {
      const parent = await createTestSitePage("new-parent");
      const child = await createTestSitePage("new-child");

      expect(await runParentPlan(child, parent.id)).toBe(true);
      expect(await pageEdges()).toEqual([[parent.id, child.id]]);
    });

    test("refuses a parent that is not a whole number", async () => {
      const page = await createTestSitePage("odd-parent");
      expect(await planParentChange(page, "1")).toEqual({
        error: "parent must be a page id or null",
        ok: false,
      });
      expect(await planParentChange(page, 1.5)).toEqual({
        error: "parent must be a page id or null",
        ok: false,
      });
    });

    test("refuses a parent id that names no page", async () => {
      const page = await createTestSitePage("lost-parent");
      expect(await planParentChange(page, page.id + 1000)).toEqual({
        error: t("site.pages.error.ineligible"),
        ok: false,
      });
    });

    test("refuses a move under the page's own descendant", async () => {
      const parent = await createTestSitePage("loop-parent");
      const child = await createTestSitePage("loop-child");
      await addPageItem(parent.id, "page", child.id);
      expect(await planParentChange(parent, child.id)).toEqual({
        error: t("site.pages.error.ineligible"),
        ok: false,
      });
    });
  });
});
