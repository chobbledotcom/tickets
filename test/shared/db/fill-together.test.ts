import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { fillTogether } from "#db/fill-together.ts";
import { hasNewsPosts, newsExistenceRead } from "#db/news-posts.ts";
import { allPageItemsRead, getAllPageItems } from "#db/site-page-items.ts";
import {
  computeSitePageSlugIndex,
  sitePages,
  sitePagesNavRead,
} from "#db/site-pages.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const navReads = [newsExistenceRead, sitePagesNavRead, allPageItemsRead];

describeWithEnv("db > fill-together", { db: true }, () => {
  test("answers the nav's three reads in a single round trip", async () => {
    await runWithRequestCache(async () => {
      const calls = await countDatabaseCalls(1, () => fillTogether(navReads));

      expect(calls).toBe(1);
    });
  });

  test("leaves every read's own cache holding the answer", async () => {
    await runWithRequestCache(async () => {
      await fillTogether(navReads);

      // Nothing reads again: the batch's answers are what these serve.
      const calls = await countDatabaseCalls(0, async () => {
        expect(await hasNewsPosts()).toBe(false);
        expect(await sitePages.getAll()).toEqual([]);
        expect(await getAllPageItems()).toEqual([]);
      });

      expect(calls).toBe(0);
    });
  });

  test("serves the rows a later reader expects, with sealed columns opened", async () => {
    const page = await sitePages.table.insert({
      name: "About us",
      slug: "about-us",
      slugIndex: await computeSitePageSlugIndex("about-us"),
      sortOrder: 3,
    });

    await runWithRequestCache(async () => {
      await fillTogether(navReads);

      expect(await sitePages.getAll()).toEqual([
        { id: page.id, name: "About us", slug: "about-us", sort_order: 3 },
      ]);
      expect(await hasNewsPosts()).toBe(false);
    });
  });

  test("asks nothing when there are no reads to fill", async () => {
    const calls = await countDatabaseCalls(0, () => fillTogether([]));

    expect(calls).toBe(0);
  });
});
