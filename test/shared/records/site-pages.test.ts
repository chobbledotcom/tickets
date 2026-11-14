import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { getSitePageById } from "#db/site-pages.ts";
import { sitePageRecord, sitePageRule } from "#shared/records/site-pages.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";
import { beforeNextTransaction } from "#test-utils/record-queries.ts";

const pageInput = (slug: string, name = "About us") => ({
  content: "",
  hidden: false,
  metaDescription: "",
  metaTitle: "",
  name,
  slug,
});

const RESERVED = "That slug is reserved — please choose another.";

describe("the site page rule", () => {
  test("refuses a slug the public site reserves", () => {
    expect(sitePageRule(pageInput("news"))).toEqual({
      error: RESERVED,
      ok: false,
    });
  });

  test("accepts a slug the public site does not reserve", () => {
    const input = pageInput("about");

    expect(sitePageRule(input)).toEqual({ ok: true, value: input });
  });
});

describe("the site page record's declaration", () => {
  test("names a page on its pages and its delete page", () => {
    expect(sitePageRecord.activityName).toBe("Page");
    expect(deleteConfirmLabel(sitePageRecord)).toBe("Page name");
  });
});

describeWithEnv("the site page record's commands", { db: true }, () => {
  test("lists the pages in their sort order", async () => {
    const first = await createTestSitePage("first");
    const second = await createTestSitePage("second");
    await execute("UPDATE site_pages SET sort_order = ? WHERE id = ?", [
      9,
      first.id,
    ]);

    expect((await sitePageRecord.getAll()).map((page) => page.slug)).toEqual([
      second.slug,
      first.slug,
    ]);
  });

  test("creates a page and logs it with the page name", async () => {
    expect(await sitePageRecord.create(pageInput("about"))).toMatchObject({
      kind: "written",
      row: { id: 1, name: "About us", slug: "about" },
    });
    expect(await activityMessages()).toEqual(["Page 'About us' created"]);
  });

  test("refuses to create a page under a reserved slug", async () => {
    expect(await sitePageRecord.create(pageInput("admin"))).toEqual({
      kind: "refused",
      message: RESERVED,
    });
  });

  test("updates a page and logs it with the page name", async () => {
    const page = await createTestSitePage("about");

    expect(
      await sitePageRecord.update(page.id, pageInput("about", "Our story")),
    ).toMatchObject({ kind: "written", row: { name: "Our story" } });
    expect(await activityMessages()).toEqual(["Page 'Our story' updated"]);
  });

  test("refuses an update to a slug another page holds", async () => {
    await createTestSitePage("taken");
    const page = await createTestSitePage("mine");

    expect(await sitePageRecord.update(page.id, pageInput("taken"))).toEqual({
      kind: "refused",
      message: "That slug is already in use by a listing, group, or page.",
    });
  });

  test("answers not-found for an update of a missing page", async () => {
    expect(await sitePageRecord.update(99, pageInput("gone"))).toEqual({
      kind: "not-found",
    });
  });

  test("answers not-found when the page is deleted before the write", async () => {
    const page = await createTestSitePage("vanishing");
    const restore = beforeNextTransaction(async () => {
      await execute("DELETE FROM site_pages WHERE id = ?", [page.id]);
    });
    try {
      expect(
        await sitePageRecord.update(page.id, pageInput("vanishing")),
      ).toEqual({ kind: "not-found" });
    } finally {
      restore();
    }
  });

  test("deletes a page and logs it with the page name", async () => {
    const page = await createTestSitePage("old", { name: "Old page" });

    expect(await sitePageRecord.remove(page.id)).toEqual({ kind: "deleted" });
    expect(await getSitePageById(page.id)).toBe(null);
    expect(await activityMessages()).toEqual(["Page 'Old page' deleted"]);
  });
});
