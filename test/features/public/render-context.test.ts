// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { TicketListing } from "#booking/model.ts";
import { setImagesForItem } from "#db/images.ts";
import { settings } from "#db/settings.ts";
import { renderCtx } from "#routes/public/render-context.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { currentRequestStore } from "#shared/request-context.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { resolved } from "#test-utils/booking-model-fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { disablePublicSite, enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** A one-listing booking context with no packages, questions, or children:
 * the plain page the tests below vary. */
const pageCtx = (
  galleryTarget: TicketCtx["galleryTarget"],
  listings: TicketListing[] = [resolved({ id: 1 })],
): TicketCtx => ({
  addOns: [],
  cartDateItems: [],
  childDatesById: new Map(),
  childrenByParentId: new Map(),
  dates: [],
  galleryImages: [],
  galleryTarget,
  listings,
  packageGroupRemainingByGroupId: new Map(),
  packageMemberGroupIds: new Map(),
  packages: [],
  pageHidden: false,
  questionListingMap: new Map(),
  questions: [],
  slugs: ["solo"],
  terms: "",
});

describeWithEnv(
  "the booking page's render context",
  { db: true, triggers: true },
  () => {
    test("builds the site menu and the page's reads when the site is on", async () => {
      await enablePublicSite();
      await withRequestContext(async () => {
        const out = await renderCtx(pageCtx({ id: 1, type: "listing" }));
        expect("nav" in out).toBe(true);
        expect(out.attributesByListing).toBeDefined();
        expect(out.groupIdsByListingId).toBeInstanceOf(Map);
        expect(out.groupRemainingByGroupId).toBeInstanceOf(Map);
        expect(out.listings.map((entry) => entry.listing.id)).toEqual([1]);
      });
    });

    test("builds no site menu on an embedded page", async () => {
      await enablePublicSite();
      await withRequestContext(
        async () => {
          const out = await renderCtx(pageCtx(null));
          expect("nav" in out).toBe(false);
        },
        { iframe: true },
      );
    });

    test("builds no site menu when the public site is off", async () => {
      await disablePublicSite();
      await withRequestContext(async () => {
        const out = await renderCtx(pageCtx(null));
        expect("nav" in out).toBe(false);
      });
    });

    test("resolves the site footer's picture into the page's image table", async () => {
      await disablePublicSite();
      const image = await makeImage("RenderCtxFooter");
      await settings.update.siteFooter(
        `Visit us.![RenderCtxFooter](img#${image.id})`,
      );
      await withRequestContext(async () => {
        await renderCtx(pageCtx(null));
        expect(currentRequestStore()?.pageImageUrls?.get(image.id)).toBe(
          `/image/${image.filename}`,
        );
      });
    });

    test("runs no footer lookup on an embedded page", async () => {
      await disablePublicSite();
      const image = await makeImage("RenderCtxEmbed");
      await settings.update.siteFooter(
        `Note.![RenderCtxEmbed](img#${image.id})`,
      );
      await withRequestContext(
        async () => {
          await renderCtx(pageCtx(null));
          expect(currentRequestStore()?.pageImageUrls?.has(image.id)).toBe(
            false,
          );
        },
        { iframe: true },
      );
    });

    test("reads the header entity's gallery pictures", async () => {
      await disablePublicSite();
      const listing = await createTestListing({ name: "Gallery Item" });
      const image = await makeImage("RenderCtxGallery");
      await setImagesForItem("listing", listing.id, [image.id]);
      await withRequestContext(async () => {
        const out = await renderCtx(
          pageCtx({ id: listing.id, type: "listing" }),
        );
        expect(out.galleryImages.map((row) => row.filename)).toEqual([
          image.filename,
        ]);
      });
    });

    test("leaves the gallery empty when the page has no header entity", async () => {
      await disablePublicSite();
      await withRequestContext(async () => {
        const out = await renderCtx(pageCtx(null));
        expect(out.galleryImages).toEqual([]);
      });
    });
  },
);
