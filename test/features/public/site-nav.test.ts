import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { publicNavModel, publicNavProps } from "#routes/public/site-nav.ts";
import { execute } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { addPageItem } from "#shared/db/site-page-items.ts";
import { computeSitePageSlugIndex, sitePages } from "#shared/db/site-pages.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const addPage = async (name: string, slug: string, sortOrder: number) =>
  sitePages.table.insert({
    name,
    slug,
    slugIndex: await computeSitePageSlugIndex(slug),
    sortOrder,
  });

describeWithEnv("public site nav", { db: true, triggers: true }, () => {
  test("lists the site's pages in their chosen order", async () => {
    await addPage("Second", "second", 2);
    await addPage("First", "first", 1);

    const model = await publicNavModel(null);

    expect(model.rootPageNodes.map((node) => node.label)).toEqual([
      "First",
      "Second",
    ]);
  });

  test("carries the settings flags and whether any news exists", async () => {
    await settings.update.terms("Some terms");
    await settings.update.orderEnabled(true);

    const before = await publicNavProps(null);
    expect(before).toMatchObject({ hasNews: false, hasTerms: true });
    expect(before.hasOrder).toBe(true);

    await createTestNewsPost("Launch day");

    expect((await publicNavProps(null)).hasNews).toBe(true);
  });

  test("builds the whole nav from a single round trip", async () => {
    await addPage("About", "about", 1);

    const calls = await runWithRequestCache(() =>
      // The three little tables the nav needs are read together, and nothing
      // it does afterwards goes back for more.
      countDatabaseCalls(1, () => publicNavProps(null)),
    );

    expect(calls).toBe(1);
  });

  test("resolves a page's listing item to a live link", async () => {
    const page = await addPage("Things", "things", 1);
    const listing = await createTestListing({ name: "Live listing" });
    await addPageItem(page.id, "listing", listing.id);

    const model = await publicNavModel(
      sitePageItemTargets.key(sitePageItemTargets.of("page")(page.id)),
    );

    expect(model.currentChildren.map((node) => node.label)).toEqual([
      "Live listing",
    ]);
    expect(model.currentChildren[0]?.href).toBe(`/ticket/${listing.slug}`);
  });

  test("keeps an inactive listing in the nav but not as a link", async () => {
    const page = await addPage("Things", "things", 1);
    const listing = await createTestListing({ name: "Off sale" });
    await addPageItem(page.id, "listing", listing.id);
    await execute("UPDATE listings SET active = 0 WHERE id = ?", [listing.id]);

    const model = await publicNavModel(
      sitePageItemTargets.key(sitePageItemTargets.of("page")(page.id)),
    );

    expect(model.currentChildren.map((node) => node.label)).toEqual([
      "Off sale",
    ]);
    expect(model.currentChildren[0]?.live).toBe(false);
  });
});
