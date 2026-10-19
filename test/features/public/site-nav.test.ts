import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { execute } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { settings } from "#db/settings.ts";
import { addPageItem } from "#db/site-page-items.ts";
import { sitePages } from "#db/site-pages.ts";
import { publicNavModel, publicNavProps } from "#routes/public/site-nav.ts";

import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createTestNewsPost,
  createTestSitePage,
} from "#test-utils/db-helpers/misc.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const addPage = async (name: string, slug: string, sortOrder: number) =>
  sitePages.table.insert({
    name,
    slug,
    slugIndex: await hmacHash(slug),
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

    const calls = await withRequestContext(() =>
      // The three little tables the nav needs are read together, and nothing
      // it does afterwards goes back for more.
      countDatabaseCalls(1, () => publicNavProps(null)),
    );

    expect(calls).toBe(1);
  });

  test("does not classify listings when the current page has none", async () => {
    const page = await addPage("About", "about", 1);
    const current = sitePageItemTargets.key(
      sitePageItemTargets.of("page")(page.id),
    );

    const calls = await withRequestContext(() =>
      // The forest's two reads answer everything: with no leaf on the page,
      // the resolution reads no listings and no groups.
      countDatabaseCalls(2, () => publicNavModel(current)),
    );

    expect(calls).toBe(2);
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

  test("keeps a required child in the nav but not as a link", async () => {
    const parent = await createTestListing({ name: "Parent" });
    const { model } = await navShowingListing("Required child", (listingId) =>
      listingChildren.setIds(parent.id, [listingId]),
    );

    expect(model.currentChildren.map((node) => node.label)).toEqual([
      "Required child",
    ]);
    expect(model.currentChildren[0]?.live).toBe(false);
  });

  test("leaves a hidden page out of the menus", async () => {
    await createTestSitePage("public-page", { name: "Public Page" });
    const hidden = await createTestSitePage("secret-page", {
      hidden: true,
      name: "Secret Page",
    });

    const model = await publicNavModel(null);

    expect(model.rootPageNodes.map((node) => node.label)).toEqual([
      "Public Page",
    ]);
    // Reading the nav as the hidden page itself highlights nothing: it is
    // not a menu entry anywhere.
    const secret = sitePageItemTargets.key(
      sitePageItemTargets.of("page")(hidden.id),
    );
    expect((await publicNavModel(secret)).activeRootId).toBeNull();
  });

  test("promotes a visible child of a hidden page to the top level", async () => {
    const parent = await createTestSitePage("hidden-parent", {
      hidden: true,
      name: "Hidden Parent",
    });
    const child = await createTestSitePage("child-page", {
      name: "Child Page",
    });
    await addPageItem(parent.id, "page", child.id);

    const model = await publicNavModel(null);

    expect(model.rootPageNodes.map((node) => node.label)).toEqual([
      "Child Page",
    ]);
    // The child's own page still anchors its nav, now as a top-level root.
    const current = sitePageItemTargets.key(
      sitePageItemTargets.of("page")(child.id),
    );
    expect((await publicNavModel(current)).activeRootId).toBe(child.id);
  });
});
