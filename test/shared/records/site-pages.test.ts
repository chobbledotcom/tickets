import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { sitePageRecord, sitePageRule } from "#shared/records/site-pages.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import {
  expectNotFoundAfterRacingDelete,
  expectRecordDelete,
  expectRefused,
  expectWrittenAndLogged,
  testMissingUpdate,
} from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";
import { describeRuleCases } from "#test-utils/rule-cases.ts";

const pageInput = (slug: string, name = "About us") => ({
  content: "",
  hidden: false,
  metaDescription: "",
  metaTitle: "",
  name,
  slug,
});

const RESERVED = "That slug is reserved — please choose another.";

describeRuleCases("the site page rule", sitePageRule, [
  ["refuses a slug the public site reserves", pageInput("news"), RESERVED],
  ["accepts a slug the public site does not reserve", pageInput("about"), null],
]);

describeRecord(sitePageRecord, "Page", "Page name", () => {
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
    await expectWrittenAndLogged(
      sitePageRecord.create(pageInput("about")),
      { id: 1, name: "About us", slug: "about" },
      ["Page 'About us' created"],
    );
  });

  test("refuses to create a page under a reserved slug", async () => {
    await expectRefused(sitePageRecord.create(pageInput("admin")), RESERVED);
  });

  test("updates a page and logs it with the page name", async () => {
    const page = await createTestSitePage("about");

    await expectWrittenAndLogged(
      sitePageRecord.update(page.id, pageInput("about", "Our story")),
      { name: "Our story" },
      ["Page 'Our story' updated"],
    );
  });

  test("refuses an update to a slug another page holds", async () => {
    await createTestSitePage("taken");
    const page = await createTestSitePage("mine");

    await expectRefused(
      sitePageRecord.update(page.id, pageInput("taken")),
      "That slug is already in use by a listing, group, or page.",
    );
  });

  testMissingUpdate(sitePageRecord, pageInput("gone"));

  test("answers not-found when the page is deleted before the write", async () => {
    const page = await createTestSitePage("vanishing");

    await expectNotFoundAfterRacingDelete(
      () => execute("DELETE FROM site_pages WHERE id = ?", [page.id]),
      () => sitePageRecord.update(page.id, pageInput("vanishing")),
    );
  });

  test("deletes a page and logs it with the page name", async () => {
    const page = await createTestSitePage("old", { name: "Old page" });

    await expectRecordDelete(sitePageRecord, page.id, [
      "Page 'Old page' deleted",
    ]);
  });
});
