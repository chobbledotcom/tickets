import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAvailableDates } from "#shared/dates.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getListingWithCount } from "#shared/db/listings/records.ts";
import { publicDailyParentWithMondayChild } from "#test/integration/server/parents-booking/_shared-setup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookableStartDates,
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  apiGet,
  apiListingRow,
  apiListingSlugs,
  listingDetail,
  makeParent,
  makeParentWithDeactivatedChild,
} from "#test-utils/parents.ts";
import { enablePublicApi } from "#test-utils/settings.ts";

describeWithEnv(
  "server > parents booking — JSON API detail & collection",
  { db: true, triggers: true },
  () => {
    test("GET /api/listings omits a child listing", async () => {
      await enablePublicApi();
      const { parent, child } = await makeParent();
      const slugs = await apiListingSlugs();
      expect(slugs).toContain(parent.slug);
      expect(slugs).not.toContain(child.slug);
    });

    test("a child listing detail endpoint is not bookable (404)", async () => {
      await enablePublicApi();
      const { child } = await makeParent();
      const res = await apiGet(`/api/listings/${child.slug}`);
      expect(res.status).toBe(404);
    });

    test("an ordinary listing API detail is unaffected", async () => {
      await enablePublicApi();
      const listing = await createTestListing({ name: "Plain" });
      const { listing: detail } = await listingDetail(listing.slug);
      expect(detail.slug).toBe(listing.slug);
      expect(detail.maxPurchasable).toBeGreaterThan(0);
    });

    test("a parent with no bookable child reads sold out in API detail", async () => {
      await enablePublicApi();
      // A child with no capacity is its parent's only child, so the parent has
      // no bookable child and is sold out.
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
      const { listing: detail } = await listingDetail<{
        isSoldOut: boolean;
        maxPurchasable: number;
      }>(parent.slug);
      expect(detail.isSoldOut).toBe(true);
      expect(detail.maxPurchasable).toBe(0);
    });

    test("API detail of a parent lists its required children with prices", async () => {
      await enablePublicApi();
      const { parent, child } = await makeParent({
        children: [{ unitPrice: 1500 }],
      });
      const { listing: detail } = await listingDetail<{
        children?: { slug: string; unitPrice: number }[];
      }>(parent.slug);
      expect(detail.children).toEqual([
        expect.objectContaining({ slug: child.slug, unitPrice: 1500 }),
      ]);
    });

    test("API detail of an ordinary listing has no children field", async () => {
      await enablePublicApi();
      const listing = await createTestListing({ name: "Plain" });
      const { listing: detail } = await listingDetail<{ children?: unknown }>(
        listing.slug,
      );
      expect(detail.children).toBeUndefined();
    });

    test("API detail omits an inactive child from a parent's children", async () => {
      await enablePublicApi();
      // An inactive child with spare capacity would, unfiltered, read
      // isClosed:false with a positive maxPurchasable while the booking fold
      // rejects it (childActive) — so the detail endpoint must not advertise it,
      // matching the availability endpoint that already reports it unavailable.
      const { parent, okChild } = await makeParentWithDeactivatedChild();
      const { listing: detail } = await listingDetail<{
        children?: { slug: string }[];
      }>(parent.slug);
      const slugs = (detail.children ?? []).map((c) => c.slug);
      expect(slugs).toEqual([okChild.slug]);
    });

    test("GET /api/listings reports a no-bookable-child parent as sold out", async () => {
      await enablePublicApi();
      // The parent's only child has no capacity, so the parent has no bookable
      // child and is sold out — the list response must project
      // that, matching the detail/availability endpoints, not advertise
      // the parent's own standalone capacity as bookable.
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
      const row = await apiListingRow(parent.slug);
      expect(row.isSoldOut).toBe(true);
      expect(row.maxPurchasable).toBe(0);
    });

    test("GET /api/listings keeps a parent with a bookable child bookable", async () => {
      await enablePublicApi();
      const { parent } = await makeParent();
      const row = await apiListingRow(parent.slug);
      expect(row.isSoldOut).toBe(false);
      expect(row.maxPurchasable).toBeGreaterThan(0);
    });

    test("apiListingRow fails fast with a clear error when the slug is absent", async () => {
      // The helper must not silently return undefined (a non-null assertion lies
      // to TypeScript); it names the missing slug so a broken test points here,
      // not at a cryptic downstream TypeError.
      await enablePublicApi();
      await expect(apiListingRow("does-not-exist")).rejects.toThrow(
        'no listing with slug "does-not-exist" found',
      );
    });

    test("API detail availableDates of a daily parent equal the child-constrained intersection", async () => {
      // The parent is bookable every weekday, but its only (daily) child is
      // bookable only on Mondays. The API detail must advertise only the dates a
      // child can serve — the intersection — so it never offers a date the web
      // selector removes and the fold rejects.
      const { parent, child } = await publicDailyParentWithMondayChild();

      const holidays = await getActiveHolidays();
      const parentDates = getAvailableDates(
        (await getListingWithCount(parent.id))!,
        holidays,
      );
      const childDates = new Set(await bookableStartDates(child.id));
      const expected = parentDates.filter((d) => childDates.has(d));

      const { listing: detail } = await listingDetail<{
        availableDates: string[];
      }>(parent.slug);
      expect(detail.availableDates).toEqual(expected);
      // The constraint actually removed dates (the parent's own calendar is wider
      // than the intersection) — otherwise the assertion would pass vacuously.
      expect(expected.length).toBeGreaterThan(0);
      expect(expected.length).toBeLessThan(parentDates.length);
    });

    test("a plain daily listing API detail keeps its full calendar", async () => {
      // A daily listing with no child edges is not a parent, so the child-date
      // constraint is a no-op: the API still advertises its own full calendar.
      await enablePublicApi();
      const listing = await createDailyTestListing({ name: "Plain daily" });
      const expected = getAvailableDates(
        (await getListingWithCount(listing.id))!,
        await getActiveHolidays(),
      );
      const { listing: detail } = await listingDetail<{
        availableDates: string[];
      }>(listing.slug);
      expect(detail.availableDates).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    });
  },
);
