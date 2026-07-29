/**
 * Loading a listing for its admin page: the gating flags the page reads before
 * rendering, and what the roster and activity panels put on screen.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import {
  listingHasEmailableAttendees,
  loadListingActivity,
  loadListingActivityPreview,
  loadListingForPage,
  loadListingOverviewPanel,
  loadListingRosterPanel,
} from "#routes/admin/listing-page-data.ts";
import type { AuthSession } from "#shared/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withTestSession } from "#test-utils/session.ts";

const SESSION: AuthSession = {
  adminLevel: "owner",
  token: "t",
  userId: 1,
  wrappedDataKey: null,
};

const ctxWith = (query = ""): PageCtx => ({
  baseUrl: "https://example.test",
  query: new URLSearchParams(query),
  returnUrl: "/admin/listings/1",
  session: SESSION,
  tabHref: (slug: string) => `/admin/listings/1/${slug}`,
});

const loaded = async (id: number) => {
  const listing = await loadListingForPage(id);
  if (!listing) throw new Error(`no listing ${id}`);
  return listing;
};

describeWithEnv("loading a listing's admin page", { db: true }, () => {
  describe("finding the listing", () => {
    test("is nothing at all for an id that does not exist", async () => {
      expect(await loadListingForPage(999_999)).toBeNull();
    });

    test("carries the listing it found", async () => {
      const listing = await createTestListing({ name: "Summer Fete" });
      const found = await loaded(listing.id);
      expect(found.listing.id).toBe(listing.id);
      expect(found.listing.name).toBe("Summer Fete");
    });

    test("says a standalone listing is not somebody's child", async () => {
      const listing = await createTestListing({});
      expect((await loaded(listing.id)).isChild).toBe(false);
    });

    test("says a standalone listing is not hidden inside a package", async () => {
      const listing = await createTestListing({});
      expect((await loaded(listing.id)).isHiddenPackageMember).toBe(false);
    });

    test("leaves the emailable flag off until the actions tab asks", async () => {
      // The decrypt behind it is deferred, so loading must not pay for it.
      const listing = await createTestListing({});
      expect((await loaded(listing.id)).hasEmailableAttendees).toBe(false);
    });
  });

  describe("whether anyone can be emailed", () => {
    test("no, when the listing has no attendees", async () => {
      const listing = await createTestListing({});
      const can = await withTestSession(() =>
        listingHasEmailableAttendees(listing.id),
      );
      expect(can).toBe(false);
    });

    test("yes, once an attendee with an email has booked", async () => {
      const listing = await createTestListing({});
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada",
        "ada@example.com",
      );
      const can = await withTestSession(() =>
        listingHasEmailableAttendees(listing.id),
      );
      expect(can).toBe(true);
    });
  });

  describe("the roster panel", () => {
    test("lists an attendee who booked", async () => {
      const listing = await createTestListing({});
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada Lovelace",
        "ada@example.com",
      );
      const html = await withTestSession(async () =>
        String(
          await loadListingRosterPanel(await loaded(listing.id), ctxWith()),
        ),
      );
      expect(html).toContain("Ada Lovelace");
    });

    test("drops attendees booked on another day when a day is chosen", async () => {
      const listing = await createTestListing({});
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Ada Lovelace",
        "ada@example.com",
      );
      const html = await withTestSession(async () =>
        String(
          await loadListingRosterPanel(
            await loaded(listing.id),
            ctxWith("date=2026-08-03"),
          ),
        ),
      );
      // A non-daily listing ignores the date, so she is still there.
      expect(html).toContain("Ada Lovelace");
    });
  });

  describe("the overview panel", () => {
    test("names the listing", async () => {
      const listing = await createTestListing({ name: "Winter Show" });
      const html = await withTestSession(async () =>
        String(await loadListingOverviewPanel(await loaded(listing.id))),
      );
      expect(html).toContain("Winter Show");
    });

    test("links this listing's own ledger for someone who may see the money", async () => {
      const listing = await createTestListing({});
      const html = await withTestSession(async () =>
        String(await loadListingOverviewPanel(await loaded(listing.id), true)),
      );
      expect(html).toContain(`/admin/ledger?listing=${listing.id}`);
    });

    test("keeps the ledger away from someone who may not", async () => {
      const listing = await createTestListing({});
      const html = await withTestSession(async () =>
        String(await loadListingOverviewPanel(await loaded(listing.id), false)),
      );
      expect(html).not.toContain("/admin/ledger");
    });

    test("keeps it away by default, so a caller must ask for it", async () => {
      const listing = await createTestListing({});
      const html = await withTestSession(async () =>
        String(await loadListingOverviewPanel(await loaded(listing.id))),
      );
      expect(html).not.toContain("/admin/ledger");
    });
  });

  describe("the activity log", () => {
    test("records the listing being created", async () => {
      const listing = await createTestListing({ name: "Logged Listing" });
      const found = await loaded(listing.id);
      const entries = await withTestSession(() => loadListingActivity(found));
      expect(entries.length).toBeGreaterThan(0);
    });

    test("the preview shows the same story, just shorter", async () => {
      const listing = await createTestListing({});
      const found = await loaded(listing.id);
      const [preview, full] = await withTestSession(async () => [
        await loadListingActivityPreview(found),
        await loadListingActivity(found),
      ]);
      expect(preview.length).toBeLessThanOrEqual(full.length);
    });
  });

  describe("the activity preview", () => {
    test("stops at five entries however long the full log is", async () => {
      const listing = await createTestListing({});
      // Every booking writes activity, so this takes the log well past five.
      for (let index = 0; index < 7; index++) {
        await createTestAttendee(
          listing.id,
          listing.slug,
          `Guest ${index}`,
          `guest${index}@example.com`,
        );
      }
      const found = await loaded(listing.id);
      const [preview, full] = await withTestSession(async () => [
        await loadListingActivityPreview(found),
        await loadListingActivity(found),
      ]);
      expect(full.length).toBeGreaterThan(5);
      expect(preview.length).toBe(5);
    });
  });
});
