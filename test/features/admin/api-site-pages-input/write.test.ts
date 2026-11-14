// Direct pins on the site-page input layer: the mapped write for a create and
// an update, and the parent plan an update runs inside its transaction.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import { addPageItem, getAllPageItems } from "#db/site-page-items.ts";
import type { SitePageWriteInput } from "#db/site-pages.ts";
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

/** Two pages, the second one nested under the first. */
const nestedPages = async (parentSlug: string, childSlug: string) => {
  const parent = await createTestSitePage(parentSlug);
  const child = await createTestSitePage(childSlug);
  await addPageItem(parent.id, "page", child.id);
  return { child, parent };
};

/** Plan a parent change, expect it to pass, and run its step in a write
 *  transaction. Answers what the step answers. */
const runParentPlan = async (page: SitePage, raw: unknown) => {
  const plan = await planParentChange(page, raw);
  if (!plan.ok) throw new Error(`parent plan refused: ${plan.error}`);
  return withTransaction(plan.value);
};

/** The write a body maps to: the form's defaults, then the given fields. */
const mappedWrite = (fields: Partial<SitePageWriteInput>) => ({
  ok: true,
  value: {
    content: "",
    hidden: false,
    metaDescription: "",
    metaTitle: "",
    ...fields,
  },
});

describeWithEnv("Site page input layer", { db: true }, () => {
  describe("toPageWrite", () => {
    test("a create with only a name and slug takes the form's defaults", () => {
      expect(toPageWrite({ name: "About", slug: "about" }, null)).toEqual(
        mappedWrite({ name: "About", slug: "about" }),
      );
    });

    test("content keeps its first-line indent and the meta fields trim", () => {
      const body = {
        content: "\n\n    code block  \n",
        meta_description: "  Short  ",
        meta_title: "  Title  ",
        name: "Docs",
        slug: "docs",
      };
      expect(toPageWrite(body, null)).toEqual(
        mappedWrite({
          content: "    code block",
          metaDescription: "Short",
          metaTitle: "Title",
          name: "Docs",
          slug: "docs",
        }),
      );
    });

    test("an update clears stored text that the body sends as empty", async () => {
      const page = await createTestSitePage("stored-text", {
        content: "Stored body",
        metaDescription: "Stored description",
        metaTitle: "Stored title",
        name: "Stored",
      });
      const body = { content: "", meta_description: "", meta_title: "" };
      expect(toPageWrite(body, page)).toEqual(
        mappedWrite({ name: "Stored", slug: "stored-text" }),
      );
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
      const first = await nestedPages("first-parent", "first-child");
      const second = await nestedPages("second-parent", "moved-child");

      expect(await runParentPlan(second.child, null)).toBe(true);
      expect(await pageEdges()).toEqual([[first.parent.id, first.child.id]]);
    });

    const placements = [
      {
        name: "re-sending the current parent writes nothing and answers true",
        nested: true,
      },
      { name: "moves a page under another page", nested: false },
    ];
    for (const { name, nested } of placements) {
      test(name, async () => {
        const parent = await createTestSitePage("placed-parent");
        const child = await createTestSitePage("placed-child");
        if (nested) await addPageItem(parent.id, "page", child.id);

        expect(await runParentPlan(child, parent.id)).toBe(true);
        expect(await pageEdges()).toEqual([[parent.id, child.id]]);
      });
    }

    test("refuses a parent that is not a page id", async () => {
      const { child, parent } = await nestedPages("loop-parent", "loop-child");
      const ineligible = t("site.pages.error.ineligible");
      const notAnId = "parent must be a page id or null";
      const cases: [SitePage, unknown, string][] = [
        [child, "1", notAnId],
        [child, 1.5, notAnId],
        [child, child.id + 1000, ineligible],
        // A move under its own descendant would close a loop.
        [parent, child.id, ineligible],
      ];
      for (const [page, raw, error] of cases) {
        expect(await planParentChange(page, raw)).toEqual({
          error,
          ok: false,
        });
      }
    });
  });
});
