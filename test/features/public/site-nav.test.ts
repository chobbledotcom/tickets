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

/** Put one listing on a page and read the nav as that page. `change` runs
 *  after the listing is placed, so a test can alter it first. */
const navShowingListing = async (
  listingName: string,
  change: (listingId: number) => Promise<unknown> = () => Promise.resolve(),
) => {
  const page = await addPage("Things", "things", 1);
  const listing = await createTestListing({ name: listingName });
  await addPageItem(page.id, "listing", listing.id);
  await change(listing.id);
  return {
    listing,
    model: await publicNavModel(
      sitePageItemTargets.key(sitePageItemTargets.of("page")(page.id)),
    ),
  };
};

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
    const { listing, model } = await navShowingListing("Live listing");

    expect(model.currentChildren.map((node) => node.label)).toEqual([
      "Live listing",
    ]);
    expect(model.currentChildren[0]?.href).toBe(`/ticket/${listing.slug}`);
    expect(model.currentChildren[0]?.live).toBe(true);
  });

  test("keeps an inactive listing in the nav but not as a link", async () => {
    const { model } = await navShowingListing("Off sale", (listingId) =>
      execute("UPDATE listings SET active = 0 WHERE id = ?", [listingId]),
    );

    expect(model.currentChildren.map((node) => node.label)).toEqual([
      "Off sale",
    ]);
    expect(model.currentChildren[0]?.live).toBe(false);
  });
});
