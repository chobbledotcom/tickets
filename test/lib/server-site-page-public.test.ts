import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { setChildIds } from "#shared/db/listing-parents.ts";
import { settings } from "#shared/db/settings.ts";
import { addPageItem } from "#shared/db/site-page-items.ts";
import {
  computeSitePageSlugIndex,
  createSitePage,
} from "#shared/db/site-pages.ts";
import type { SitePage } from "#shared/types.ts";
import {
  assertPublicHtml,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectRedirect,
  expectStatus,
  mockRequest,
} from "#test-utils";

/** Create a page directly (the admin flow is covered elsewhere). */
const makePage = async (
  slug: string,
  extra: Partial<
    Pick<SitePage, "content" | "meta_description" | "meta_title">
  > = {},
): Promise<SitePage> =>
  createSitePage({
    content: extra.content ?? "",
    metaDescription: extra.meta_description ?? "",
    metaTitle: extra.meta_title ?? "",
    name: `Page ${slug}`,
    slug,
    slugIndex: await computeSitePageSlugIndex(slug),
  });

const enablePublicSite = (): void => {
  beforeEach(async () => {
    await settings.update.showPublicSite(true);
  });
  afterEach(async () => {
    await settings.update.showPublicSite(false);
  });
};

describeWithEnv("server (public site pages)", { db: true }, () => {
  describe("gate + resolution", () => {
    test("redirects to admin login before any slug lookup when the site is off", async () => {
      await makePage("hidden-while-off");
      const response = await handleRequest(
        mockRequest("/page/hidden-while-off"),
      );
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("404s an unknown slug", async () => {
      await settings.update.showPublicSite(true);
      try {
        expectStatus(404)(await handleRequest(mockRequest("/page/no-such")));
      } finally {
        await settings.update.showPublicSite(false);
      }
    });
  });

  describe("page rendering", () => {
    enablePublicSite();

    test("renders the name, markdown content, and SEO meta", async () => {
      await makePage("about-us", {
        content: "Hello **world**",
        meta_description: 'We sell "things" & fun',
        meta_title: "About | Acme",
      });
      const html = await assertPublicHtml("/page/about-us");
      expect(html).toContain("<h1>Page about-us</h1>");
      expect(html).toContain("<strong>world</strong>");
      expect(html).toContain("<title>About | Acme</title>");
      // The description is escaped into the net-new meta tag.
      expect(html).toContain(
        '<meta name="description" content="We sell &quot;things&quot; &amp; fun" />',
      );
      // No items ⇒ no item list at all.
      expect(html).not.toContain('class="page-items"');
    });

    test("falls back to the page name for the title; no meta tag when empty", async () => {
      await settings.update.websiteTitle("Acme Site");
      try {
        await makePage("plain");
        const html = await assertPublicHtml("/page/plain");
        expect(html).toContain("<title>Page plain - Acme Site</title>");
        expect(html).not.toContain('name="description"');
      } finally {
        await settings.update.websiteTitle("");
      }
    });

    test("renders live items as links and dead items as text", async () => {
      const page = await makePage("catalogue");
      const live = await createTestListing({ name: "Live Listing" });
      const dead = await createTestListing({ name: "Dead Listing" });
      await deactivateTestListing(dead.id);
      const parent = await createTestListing({ name: "Parent Listing" });
      const child = await createTestListing({ name: "Child Listing" });
      await setChildIds(parent.id, [child.id]);
      // A parent whose only child is unavailable is projected sold out —
      // discovery hides its booking CTA, so the nav must not link it either.
      const soldOutParent = await createTestListing({ name: "Starved Parent" });
      const starvedChild = await createTestListing({ name: "Starved Child" });
      await setChildIds(soldOutParent.id, [starvedChild.id]);
      await deactivateTestListing(starvedChild.id);
      // A renewal tier bought via a normal public link would take payment
      // without extending the site, so it must never be linked.
      const tier = await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Tier Listing",
        purchaseOnly: true,
      });
      const fullGroup = await createTestGroup({
        name: "Full Group",
        slug: "fg",
      });
      await createTestListing({ groupId: fullGroup.id, name: "Member" });
      const emptyGroup = await createTestGroup({
        name: "Empty Group",
        slug: "eg",
      });
      for (const [type, id] of [
        ["listing", live.id],
        ["listing", dead.id],
        ["listing", child.id],
        ["listing", parent.id],
        ["listing", soldOutParent.id],
        ["listing", tier.id],
        ["group", fullGroup.id],
        ["group", emptyGroup.id],
      ] as const) {
        await addPageItem(page.id, type, id);
      }
      const html = await assertPublicHtml("/page/catalogue");
      expect(html).toContain('class="page-items"');
      // Reachable targets link — including a parent with a bookable child;
      // unreachable ones are plain text (never a dead link): inactive listing,
      // child listing, sold-out parent, renewal tier, member-less group.
      expect(html).toContain(`href="/ticket/${live.slug}"`);
      expect(html).toContain(`href="/ticket/${parent.slug}"`);
      expect(html).toContain(`href="/ticket/fg"`);
      expect(html).toContain("<span>Dead Listing</span>");
      expect(html).toContain("<span>Child Listing</span>");
      expect(html).toContain("<span>Starved Parent</span>");
      expect(html).toContain("<span>Tier Listing</span>");
      expect(html).toContain("<span>Empty Group</span>");
      expect(html).not.toContain(`href="/ticket/${dead.slug}"`);
      expect(html).not.toContain(`href="/ticket/${child.slug}"`);
      expect(html).not.toContain(`href="/ticket/${soldOutParent.slug}"`);
      expect(html).not.toContain(`href="/ticket/${tier.slug}"`);
      expect(html).not.toContain(`href="/ticket/eg"`);
    });
  });

  describe("recursive nav", () => {
    enablePublicSite();

    test("nav flags follow their settings: no contact/terms/order when unset", async () => {
      // The test env's contact form is active (business email set), so switch
      // it off to expose the raw flags.
      await settings.update.contactFormEnabled(false);
      try {
        await makePage("flagless");
        const html = await assertPublicHtml("/page/flagless");
        expect(html).not.toContain('href="/contact"');
        expect(html).not.toContain('href="/terms"');
        expect(html).not.toContain('href="/order"');
        // Setting the contact text alone turns the Contact link on.
        await settings.update.contactPageText("Write to us");
        const withText = await assertPublicHtml("/page/flagless");
        expect(withText).toContain('href="/contact"');
      } finally {
        await settings.update.contactPageText("");
        await settings.update.contactFormEnabled(true);
      }
    });

    test("root pages sit between Listings and Contact on the fixed pages", async () => {
      await settings.update.contactPageText("Write to us");
      try {
        await makePage("first-root");
        await makePage("second-root");
        const html = await assertPublicHtml("/");
        const desktop = html.slice(0, html.indexOf("admin-nav--mobile"));
        const listings = desktop.indexOf('href="/listings"');
        const first = desktop.indexOf('href="/page/first-root"');
        const second = desktop.indexOf('href="/page/second-root"');
        const contact = desktop.indexOf('href="/contact"');
        expect(listings).toBeGreaterThan(-1);
        expect(first).toBeGreaterThan(listings);
        expect(second).toBeGreaterThan(first);
        expect(contact).toBeGreaterThan(second);
      } finally {
        await settings.update.contactPageText("");
      }
    });

    test("a nested page shows the active chain: nested desktop, stacked mobile", async () => {
      const root = await makePage("services");
      // A sibling page BEFORE the chain page, so the chain must be followed by
      // the active page node — not merely the first page node — at each level.
      const sibling = await makePage("gardening");
      await addPageItem(root.id, "page", sibling.id);
      const nested = await makePage("cleaning");
      await addPageItem(root.id, "page", nested.id);
      const deepest = await makePage("windows");
      await addPageItem(nested.id, "page", deepest.id);

      const html = await assertPublicHtml("/page/cleaning");
      // Desktop: the active root carries the nested subnav; the chain page is
      // marked active at each level, its sibling is not.
      expect(html).toContain('class="admin-subnav"');
      expect(html).toContain(
        `<a class="active" href="/page/services">Page services</a>`,
      );
      expect(html).toContain(
        `<a class="active" href="/page/cleaning">Page cleaning</a>`,
      );
      expect(html).toContain(`<a href="/page/gardening">Page gardening</a>`);
      // The current page's own children are offered as the deepest level (N7).
      expect(html).toContain('href="/page/windows"');
      // Mobile: one stacked bar per level, named after its parent page (the
      // ACTIVE chain page, not the sibling that happens to sort first).
      expect(html).toContain('aria-label="Site menu"');
      expect(html).toContain('aria-label="Page services"');
      expect(html).toContain('aria-label="Page cleaning"');
      expect(html).not.toContain('aria-label="Page gardening"');
    });

    test("the fixed pages show no submenu bars (no active chain)", async () => {
      await makePage("solo");
      const html = await assertPublicHtml("/listings");
      expect(html).toContain('href="/page/solo"');
      expect(html).not.toContain('class="admin-subnav"');
      expect(html).not.toContain('aria-label="Page solo"');
    });

    test("the order gallery carries the root pages too", async () => {
      await settings.update.orderEnabled(true);
      try {
        await makePage("gallery-root");
        const html = await assertPublicHtml("/order");
        expect(html).toContain('href="/page/gallery-root"');
      } finally {
        await settings.update.orderEnabled(false);
      }
    });
  });
});
