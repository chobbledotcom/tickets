import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { groups } from "#shared/db/groups.ts";
import { appendImageToItem, imagesTable } from "#shared/db/images.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { addPageItem } from "#shared/db/site-page-items.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import {
  assertPublicHtml,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage as makePage } from "#test-utils/db-helpers/misc.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  featureSetting,
  useSetting,
  withSetting,
} from "#test-utils/settings.ts";

describeWithEnv("server (public site pages)", { db: true }, () => {
  describe("gate + resolution", () => {
    test("redirects to admin login before any slug lookup when the site is off", async () => {
      await makePage("hidden-while-off");
      const response = await handleRequest(
        mockRequest("/page/hidden-while-off"),
      );
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("404s an unknown slug", () =>
      withSetting(featureSetting("site"), async () => {
        expectStatus(404)(await handleRequest(mockRequest("/page/no-such")));
      }));
  });

  describe("page rendering", () => {
    useSetting(featureSetting("site"));

    test("renders the name, markdown content, and SEO meta", async () => {
      await makePage("about-us", {
        content: "Hello **world**",
        metaDescription: 'We sell "things" & fun',
        metaTitle: "About | Acme",
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
      // The login footer is a homepage-only affordance (#69).
      expect(html).not.toContain('href="/admin/login"');
    });

    test("falls back to the page name for the title; no meta tag when empty", () =>
      withSetting({ website_title: "Acme Site" }, async () => {
        await makePage("plain");
        const html = await assertPublicHtml("/page/plain");
        expect(html).toContain("<title>Page plain - Acme Site</title>");
        expect(html).not.toContain('name="description"');
      }));

    test("renders the page's linked images as the shared CSS gallery", async () => {
      const page = await makePage("gallery-page");
      const first = await imagesTable.insert({
        altText: "First alt",
        filename: nonEmptyString("one.webp"),
        filenameThumb: nonEmptyString("one-thumb.webp"),
        name: "One",
      });
      const second = await imagesTable.insert({
        altText: "",
        filename: nonEmptyString("two.webp"),
        filenameThumb: nonEmptyString("two-thumb.webp"),
        name: "Two",
      });
      await appendImageToItem(first.id, { id: page.id, kind: "page" });
      await appendImageToItem(second.id, { id: page.id, kind: "page" });

      const html = await assertPublicHtml("/page/gallery-page");
      // The public page now shows the images an editor attached, as the same
      // CSS-only gallery the news post page uses.
      expect(html).toContain('class="news-gallery"');
      expect(html).toContain("one.webp");
      expect(html).toContain('alt="First alt"');
      // Two images ⇒ a swappable thumbnail per image.
      expect(html).toContain(
        '<label class="news-gallery-thumb" for="news-gallery-0">',
      );
      expect(html).toContain(
        '<label class="news-gallery-thumb" for="news-gallery-1">',
      );
    });

    test("renders no gallery when the page has no images", async () => {
      await makePage("imageless");
      const html = await assertPublicHtml("/page/imageless");
      expect(html).not.toContain("news-gallery");
    });

    test("renders live items as links and dead items as text", async () => {
      const page = await makePage("catalogue");
      const live = await createTestListing({ name: "Live Listing" });
      const dead = await createTestListing({ name: "Dead Listing" });
      await deactivateTestListing(dead.id);
      const parent = await createTestListing({ name: "Parent Listing" });
      const child = await createTestListing({ name: "Child Listing" });
      await listingChildren.setIds(parent.id, [child.id]);
      // A parent whose only child is unavailable is projected sold out —
      // discovery hides its booking CTA, so the nav must not link it either.
      const soldOutParent = await createTestListing({ name: "Starved Parent" });
      const starvedChild = await createTestListing({ name: "Starved Child" });
      await listingChildren.setIds(soldOutParent.id, [starvedChild.id]);
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
    useSetting(featureSetting("site"));

    test("nav flags follow their settings: no contact/terms/order when unset", () =>
      // The test env's contact form is active (business email set), so switch
      // it off to expose the raw flags.
      withSetting({ contact_form_enabled: false }, async () => {
        await makePage("flagless");
        const html = await assertPublicHtml("/page/flagless");
        expect(html).not.toContain('href="/contact"');
        expect(html).not.toContain('href="/terms"');
        expect(html).not.toContain('href="/order"');
        // Setting the contact text alone turns the Contact link on.
        await withSetting({ contact_page_text: "Write to us" }, async () => {
          const withText = await assertPublicHtml("/page/flagless");
          expect(withText).toContain('href="/contact"');
        });
      }));

    test("root pages sit between Listings and Contact on the fixed pages", () =>
      withSetting({ contact_page_text: "Write to us" }, async () => {
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
      }));

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

    test("a group is live when ANY member is bookable, not just the first", async () => {
      // Members iterate newest-first (created DESC), so create the bookable
      // member before the unbookable child: the liveness fold must accumulate
      // past the dead first row to find the bookable one.
      const page = await makePage("mixed-group");
      const grp = await createTestGroup({ name: "Mixed Group", slug: "mg" });
      await createTestListing({ groupId: grp.id, name: "Bookable Member" });
      const parent = await createTestListing({ name: "Outside Parent" });
      const childMember = await createTestListing({
        groupId: grp.id,
        name: "Child Member",
      });
      await listingChildren.setIds(parent.id, [childMember.id]);
      await addPageItem(page.id, "group", grp.id);
      const html = await assertPublicHtml("/page/mixed-group");
      expect(html).toContain('href="/ticket/mg"');
    });

    test("a page whose only item is a member-less group renders it dead", async () => {
      // The liveness pass has nothing to classify here (no listings anywhere
      // in the model) — the group must still resolve, as a dead entry.
      const page = await makePage("ghost-town");
      const empty = await createTestGroup({ name: "Ghost Group", slug: "gg" });
      await addPageItem(page.id, "group", empty.id);
      const html = await assertPublicHtml("/page/ghost-town");
      expect(html).toContain("<span>Ghost Group</span>");
      expect(html).not.toContain('href="/ticket/gg"');
    });

    test("a page with a missing listing item still renders", async () => {
      const page = await makePage("missing-listing-item");
      await addPageItem(page.id, "listing", 999_999);

      const html = await assertPublicHtml("/page/missing-listing-item");
      expect(html).toContain("<h1>Page missing-listing-item</h1>");
      expect(html).not.toContain('href="/ticket/');
    });

    test("a package group with an incomplete bundle renders dead despite a bookable member", async () => {
      // A package is all-or-nothing: one inactive member makes the whole bundle
      // unbuyable, so its /ticket/<group> page 404s. The nav link must be dead
      // even though the other member is individually bookable — the group gate
      // uses the package bundle cap, not "any bookable member".
      const page = await makePage("broken-bundle");
      const group = await createTestGroup({
        isPackage: true,
        name: "Combo",
        slug: "combo",
      });
      await createTestListing({ groupId: group.id, name: "Live Member" });
      const dead = await createTestListing({
        groupId: group.id,
        name: "Dead Member",
      });
      await deactivateTestListing(dead.id);
      await addPageItem(page.id, "group", group.id);
      const html = await assertPublicHtml("/page/broken-bundle");
      expect(html).toContain("<span>Combo</span>");
      expect(html).not.toContain('href="/ticket/combo"');
    });

    test("a hidden package member as a listing item renders dead (no standalone page)", async () => {
      // A hidden package's member 404s its own /ticket page — only the package
      // name is public — so a nav leaf pointing at it must not render a live link.
      const page = await makePage("hidden-member");
      const group = await createTestGroup({ isPackage: true, name: "Bundle" });
      await groups.table.update(group.id, {
        hidePackageListings: true,
        isPackage: true,
      });
      const member = await createTestListing({
        groupId: group.id,
        name: "Secret Member",
      });
      await addPageItem(page.id, "listing", member.id);
      const html = await assertPublicHtml("/page/hidden-member");
      expect(html).toContain("<span>Secret Member</span>");
      expect(html).not.toContain(`href="/ticket/${member.slug}"`);
    });

    test("an item-less page renders no empty submenu or mobile bar", async () => {
      // The page's own (deepest) level is empty: a <ul> with no <li> children
      // is invalid markup, and an empty aria-labelled nav bar is announced to
      // screen-reader users as a navigation landmark with nothing in it.
      await makePage("bare");
      const html = await assertPublicHtml("/page/bare");
      expect(html).not.toContain('class="admin-subnav"');
      expect(html).not.toContain('aria-label="Page bare"');
    });

    test("the public nav never carries the admin #main-nav id", async () => {
      // The stylesheet reads #main-nav as "this is an admin page" (full-bleed
      // main, admin textarea sizing); a public page must keep the shared
      // reading width, while .admin-nav-group still pins the desktop sidebar.
      await makePage("styled");
      const html = await assertPublicHtml("/page/styled");
      expect(html).not.toContain('id="main-nav"');
      expect(html).toContain('class="admin-nav-group"');
    });

    test("the order gallery carries the root pages too", () =>
      withSetting({ order_enabled: true }, async () => {
        await makePage("gallery-root");
        const html = await assertPublicHtml("/order");
        expect(html).toContain('href="/page/gallery-root"');
      }));
  });
});
