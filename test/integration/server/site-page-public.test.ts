import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { appendImageToItem, imagesTable } from "#db/images.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { addPageItem } from "#db/site-page-items.ts";
import { handleRequest } from "#routes";
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
      assertStringIncludes(html, "<h1>Page about-us</h1>");
      assertStringIncludes(html, "<strong>world</strong>");
      assertStringIncludes(html, "<title>About | Acme</title>");
      // The description is escaped into the net-new meta tag.
      assertStringIncludes(
        html,
        '<meta name="description" content="We sell &quot;things&quot; &amp; fun" />',
      );
      // No items ⇒ no item list at all.
      assert(
        !html.includes('class="page-items"'),
        "the value should not contain the searched item",
      );
      // The login footer is a homepage-only affordance (#69).
      assert(
        !html.includes('href="/admin/login"'),
        "the value should not contain the searched item",
      );
    });

    test("falls back to the page name for the title; no meta tag when empty", () =>
      withSetting({ website_title: "Acme Site" }, async () => {
        await makePage("plain");
        const html = await assertPublicHtml("/page/plain");
        assertStringIncludes(html, "<title>Page plain - Acme Site</title>");
        assert(
          !html.includes('name="description"'),
          "the value should not contain the searched item",
        );
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
      assertStringIncludes(html, 'class="news-gallery"');
      assertStringIncludes(html, "one.webp");
      assertStringIncludes(html, 'alt="First alt"');
      // Two images ⇒ a swappable thumbnail per image.
      assertStringIncludes(
        html,
        '<label class="news-gallery-thumb" for="news-gallery-0">',
      );
      assertStringIncludes(
        html,
        '<label class="news-gallery-thumb" for="news-gallery-1">',
      );
    });

    test("renders no gallery when the page has no images", async () => {
      await makePage("imageless");
      const html = await assertPublicHtml("/page/imageless");
      assert(
        !html.includes("news-gallery"),
        "the value should not contain the searched item",
      );
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
      assertStringIncludes(html, 'class="page-items"');
      // Reachable targets link — including a parent with a bookable child;
      // unreachable ones are plain text (never a dead link): inactive listing,
      // child listing, sold-out parent, renewal tier, member-less group.
      assertStringIncludes(html, `href="/ticket/${live.slug}"`);
      assertStringIncludes(html, `href="/ticket/${parent.slug}"`);
      assertStringIncludes(html, `href="/ticket/fg"`);
      assertStringIncludes(html, "<span>Dead Listing</span>");
      assertStringIncludes(html, "<span>Child Listing</span>");
      assertStringIncludes(html, "<span>Starved Parent</span>");
      assertStringIncludes(html, "<span>Tier Listing</span>");
      assertStringIncludes(html, "<span>Empty Group</span>");
      assert(
        !html.includes(`href="/ticket/${dead.slug}"`),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes(`href="/ticket/${child.slug}"`),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes(`href="/ticket/${soldOutParent.slug}"`),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes(`href="/ticket/${tier.slug}"`),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes(`href="/ticket/eg"`),
        "the value should not contain the searched item",
      );
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
        assert(
          !html.includes('href="/contact"'),
          "the value should not contain the searched item",
        );
        assert(
          !html.includes('href="/terms"'),
          "the value should not contain the searched item",
        );
        assert(
          !html.includes('href="/order"'),
          "the value should not contain the searched item",
        );
        // Setting the contact text alone turns the Contact link on.
        await withSetting({ contact_page_text: "Write to us" }, async () => {
          const withText = await assertPublicHtml("/page/flagless");
          assertStringIncludes(withText, 'href="/contact"');
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
      assertStringIncludes(html, 'class="admin-subnav"');
      assertStringIncludes(
        html,
        `<a class="active" href="/page/services">Page services</a>`,
      );
      assertStringIncludes(
        html,
        `<a class="active" href="/page/cleaning">Page cleaning</a>`,
      );
      assertStringIncludes(
        html,
        `<a href="/page/gardening">Page gardening</a>`,
      );
      // The current page's own children are offered as the deepest level (N7).
      assertStringIncludes(html, 'href="/page/windows"');
      // Mobile: one stacked bar per level, named after its parent page (the
      // ACTIVE chain page, not the sibling that happens to sort first).
      assertStringIncludes(html, 'aria-label="Site menu"');
      assertStringIncludes(html, 'aria-label="Page services"');
      assertStringIncludes(html, 'aria-label="Page cleaning"');
      assert(
        !html.includes('aria-label="Page gardening"'),
        "the value should not contain the searched item",
      );
    });

    test("the fixed pages show no submenu bars (no active chain)", async () => {
      await makePage("solo");
      const html = await assertPublicHtml("/listings");
      assertStringIncludes(html, 'href="/page/solo"');
      assert(
        !html.includes('class="admin-subnav"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('aria-label="Page solo"'),
        "the value should not contain the searched item",
      );
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
      assertStringIncludes(html, 'href="/ticket/mg"');
    });

    test("a page whose only item is a member-less group renders it dead", async () => {
      // The liveness pass has nothing to classify here (no listings anywhere
      // in the model) — the group must still resolve, as a dead entry.
      const page = await makePage("ghost-town");
      const empty = await createTestGroup({ name: "Ghost Group", slug: "gg" });
      await addPageItem(page.id, "group", empty.id);
      const html = await assertPublicHtml("/page/ghost-town");
      assertStringIncludes(html, "<span>Ghost Group</span>");
      assert(
        !html.includes('href="/ticket/gg"'),
        "the value should not contain the searched item",
      );
    });

    test("a page with a missing listing item still renders", async () => {
      const page = await makePage("missing-listing-item");
      await addPageItem(page.id, "listing", 999_999);

      const html = await assertPublicHtml("/page/missing-listing-item");
      assertStringIncludes(html, "<h1>Page missing-listing-item</h1>");
      assert(
        !html.includes('href="/ticket/'),
        "the value should not contain the searched item",
      );
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
      assertStringIncludes(html, "<span>Combo</span>");
      assert(
        !html.includes('href="/ticket/combo"'),
        "the value should not contain the searched item",
      );
    });

    test("a concealing package member keeps its listing item link", async () => {
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
      assertStringIncludes(html, `href="/ticket/${member.slug}"`);
    });

    test("an item-less page renders no empty submenu or mobile bar", async () => {
      // The page's own (deepest) level is empty: a <ul> with no <li> children
      // is invalid markup, and an empty aria-labelled nav bar is announced to
      // screen-reader users as a navigation landmark with nothing in it.
      await makePage("bare");
      const html = await assertPublicHtml("/page/bare");
      assert(
        !html.includes('class="admin-subnav"'),
        "the value should not contain the searched item",
      );
      assert(
        !html.includes('aria-label="Page bare"'),
        "the value should not contain the searched item",
      );
    });

    test("the public nav never carries the admin #main-nav id", async () => {
      // The stylesheet reads #main-nav as "this is an admin page" (full-bleed
      // main, admin textarea sizing); a public page must keep the shared
      // reading width, while .admin-nav-group still pins the desktop sidebar.
      await makePage("styled");
      const html = await assertPublicHtml("/page/styled");
      assert(
        !html.includes('id="main-nav"'),
        "the value should not contain the searched item",
      );
      assertStringIncludes(html, 'class="admin-nav-group"');
    });

    test("the order gallery carries the root pages too", () =>
      withSetting({ order_enabled: true }, async () => {
        await makePage("gallery-root");
        const html = await assertPublicHtml("/order");
        assertStringIncludes(html, 'href="/page/gallery-root"');
      }));
  });
});
