import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createSitePage } from "#db/site-pages.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const makePage = (slug: string, name: string) =>
  createSitePage({
    content: `Everything about ${name}.`,
    metaDescription: `${name} description`,
    metaTitle: `${name} title`,
    name,
    slug,
  });

describeWithEnv("public /page/:slug route", { db: true }, () => {
  test("renders a page's name and content by its slug", async () => {
    await enablePublicSite();
    await makePage("about-us", "About Us");
    const response = await handleRequest(mockRequest("/page/about-us"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("About Us");
    expect(body).toContain("Everything about About Us.");
  });

  test("an unknown slug 404s", async () => {
    await enablePublicSite();
    const response = await handleRequest(mockRequest("/page/no-such-page"));
    expect(response.status).toBe(404);
  });

  test("a slug owned by a listing cannot become a page", async () => {
    await enablePublicSite();
    const { createTestListing } = await import(
      "#test-utils/db-helpers/listings.ts"
    );
    const listing = await createTestListing();
    // Listings, groups, and pages share one slug namespace, so a page create
    // under the listing's address reports slugTaken and no page appears.
    const taken = await makePage(listing.slug, "Squatter");
    expect(taken.ok).toBe(false);
    const response = await handleRequest(mockRequest(`/page/${listing.slug}`));
    expect(response.status).toBe(404);
  });
});
