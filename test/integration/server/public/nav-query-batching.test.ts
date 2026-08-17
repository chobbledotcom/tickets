import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** The three small reads every public page's nav needs. */
const NAV_READS = [
  "SELECT id FROM news_posts LIMIT 1",
  "FROM site_pages",
  "FROM site_page_items",
];

const navReadsFor = (seen: readonly string[]): string[][] =>
  NAV_READS.map((fragment) => seen.filter((sql) => sql.includes(fragment)));

const recordPublicPage = async (path: string): Promise<string[]> => {
  await enablePublicSite();
  const seen: string[] = [];
  const restore = recordQueries(seen);
  try {
    await assertPublicHtml(path);
  } finally {
    restore();
  }
  return seen;
};

describeWithEnv(
  "server public > nav read batching",
  { db: true, triggers: true },
  () => {
    test("reads news, pages, and page items once each for the home page", async () => {
      const seen = await recordPublicPage("/");

      // Each still runs exactly once — the batch replaces three round trips
      // with one, it must not read anything twice or drop a read.
      expect(navReadsFor(seen).map((reads) => reads.length)).toEqual([1, 1, 1]);
    });

    test("shares the batched reads with the rest of the listings page", async () => {
      const seen = await recordPublicPage("/listings");

      expect(navReadsFor(seen).map((reads) => reads.length)).toEqual([1, 1, 1]);
    });
  },
);
