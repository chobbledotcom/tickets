/**
 * The `bookable_alone` flag: a child listing flagged
 * `bookable_alone = true` keeps its OWN standalone booking page, catalogue
 * entry, feed item, JSON-API eligibility and share/QR affordances, while still
 * folding under its parents — the split of the historic "being a child strips
 * standalone existence" invariant into two predicates. Every surface below is
 * the flag-ON mirror of a suppression in server-parents-discovery.test.ts /
 * server-parents-booking.test.ts, so the two together lock both polarities.
 *
 * Group liveness stays STRUCTURAL: a regular group whose only members are
 * flagged children is folded away on its `/ticket/<group>` page, so it must not
 * be advertised live even though each member's own card is bookable.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { groups } from "#shared/db/groups.ts";
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
  updateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiGet,
  apiListingSlugs,
  makeParent,
  publicBody,
  ticketPageStatus,
} from "#test-utils/parents.ts";
import { adminGet } from "#test-utils/session.ts";

/** A parent with a single `bookable_alone` child (the headline shape). */
const parentWithFlaggedChild = () =>
  makeParent({
    children: [{ bookableAlone: true, name: "Solo Widget" }],
    parent: { name: "Widget Picker" },
  });

describeWithEnv(
  "server > bookable_alone child surfaces",
  { db: true, triggers: true },
  () => {
    describe("standalone booking page", () => {
      test("a bookable_alone child's /ticket page renders (200), not 404", async () => {
        const { child } = await parentWithFlaggedChild();
        await settings.update.showPublicSite(true);
        const response = await handleRequest(
          mockRequest(`/ticket/${child.slug}`),
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("Solo Widget");
      });

      test("a plain (non-flagged) child under the same shape still 404s", async () => {
        // Regression floor: only the flag opens the page; a plain child is
        // rejected by the slug guard exactly as before.
        const { child } = await makeParent({
          children: [{ name: "Folded Only" }],
          parent: { name: "Picker" },
        });
        expect(await ticketPageStatus(child.slug)).toBe(404);
      });
    });

    describe("public listing cards (/listings)", () => {
      test("a bookable_alone child shows a Book CTA, not the add-on note", async () => {
        const { parent, child } = await parentWithFlaggedChild();
        const body = await publicBody("/listings");
        expect(body).toContain("Solo Widget");
        // Its own standalone CTA is present; the add-on note is NOT shown.
        expect(body).toContain(`href="/ticket/${child.slug}"`);
        expect(body).not.toContain("Available as an add-on to another booking");
        // The parent keeps its own Book link too.
        expect(body).toContain(`href="/ticket/${parent.slug}"`);
      });
    });

    describe("/order gallery", () => {
      test("offers a bookable_alone child as a selectable card", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.orderEnabled(true);
        const { child } = await parentWithFlaggedChild();
        const body = await (await handleRequest(mockRequest("/order"))).text();
        expect(body).toContain(`name="select_${child.id}"`);
        expect(body).toContain("Solo Widget");
      });
    });

    describe("RSS/ICS feeds", () => {
      test("keeps a bookable_alone child's own feed item", async () => {
        const { child } = await parentWithFlaggedChild();
        await settings.update.showPublicSite(true);
        const rss = await (
          await handleRequest(mockRequest("/feeds/listings.rss"))
        ).text();
        expect(rss).toContain(`/ticket/${child.slug}`);
      });
    });

    describe("JSON API", () => {
      test("lists a bookable_alone child and its detail is bookable (200)", async () => {
        await settings.update.showPublicApi(true);
        const { child } = await parentWithFlaggedChild();
        const slugs = await apiListingSlugs();
        expect(slugs).toContain(child.slug);
        const res = await apiGet(`/api/listings/${child.slug}`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          listing: { slug: string; maxPurchasable: number };
        };
        expect(body.listing.slug).toBe(child.slug);
        expect(body.listing.maxPurchasable).toBeGreaterThan(0);
      });

      test("a bookable_alone child's availability endpoint is reachable (200)", async () => {
        await settings.update.showPublicApi(true);
        const { child } = await parentWithFlaggedChild();
        const res = await apiGet(`/api/listings/${child.slug}/availability`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { available: boolean };
        expect(body.available).toBe(true);
      });
    });

    describe("admin surfaces", () => {
      test("the multi-booking builder offers a bookable_alone child", async () => {
        const { child } = await parentWithFlaggedChild();
        const body = await (await adminGet("/admin/")).text();
        expect(body).toContain(`data-multi-booking-slug="${child.slug}"`);
      });

      test("a bookable_alone child keeps its share/QR affordances", async () => {
        const { child } = await parentWithFlaggedChild();
        const body = await (
          await adminGet(`/admin/listing/${child.id}`)
        ).text();
        expect(body).toContain(`/ticket/${child.slug}`);
        expect(body).not.toContain(
          "it has no standalone booking link, embed, or QR code",
        );
      });
    });

    describe("group liveness stays structural", () => {
      test("a group whose only members are flagged children is NOT advertised live", async () => {
        // The child is bookable on its OWN card, but the group page folds it
        // away — so the group must not advertise a live Book link.
        const group = await createTestGroup({ name: "Widgets" });
        const parent = await createTestListing({
          groupId: group.id,
          name: "In-group Picker",
        });
        const child = await createTestListing({
          bookableAlone: true,
          groupId: group.id,
          name: "Grouped Widget",
        });
        await listingChildren.setIds(parent.id, [child.id]);
        // Deactivate the parent so the group's ONLY standalone-eligible member is
        // the flagged child; if group liveness used the narrowed set it would now
        // (wrongly) go live.
        await deactivateTestListing(parent.id);
        const body = await publicBody("/listings");
        // The child's own card is bookable...
        expect(body).toContain(`href="/ticket/${child.slug}"`);
        // ...but the group's own /ticket/<group> Book link is not advertised.
        expect(body).not.toContain(`href="/ticket/${group.slug}"`);
      });
    });

    describe("hidden-package concealment still wins", () => {
      test("a hidden package member stays concealed even if bookable_alone", async () => {
        // The hidden-member arm of the gate outranks the flag: a hidden package's
        // member has no standalone page regardless of bookable_alone.
        const group = await createTestGroup({
          isPackage: true,
          name: "Bundle",
        });
        // hide_package_listings isn't exposed by the create form helper, so set
        // it directly — the concealment predicate reads this column.
        await groups.table.update(group.id, {
          hidePackageListings: true,
          isPackage: true,
        });
        const member = await createTestListing({
          bookableAlone: true,
          groupId: group.id,
          name: "Concealed Member",
        });
        expect(await ticketPageStatus(member.slug)).toBe(404);
      });
    });

    describe("flag transitions on listing save (no orphaned add-on)", () => {
      test("clearing bookable_alone on a child is allowed when nothing is orphaned", async () => {
        // The false-transition guard runs but finds no child-scoped add-on to
        // orphan, so the save succeeds and the flag flips off (the child's
        // /ticket page then 404s again).
        const { child } = await parentWithFlaggedChild();
        expect(await ticketPageStatus(child.slug)).toBe(200);
        await updateTestListing(child.id, { bookableAlone: false });
        expect((await listingsTable.findById(child.id))!.bookable_alone).toBe(
          false,
        );
        expect(await ticketPageStatus(child.slug)).toBe(404);
      });

      test("clearing bookable_alone on a NON-child listing is a no-op guard", async () => {
        // The flag is inert for a listing with no parents, so clearing it never
        // runs the reachability guard — the save just succeeds.
        const solo = await createTestListing({
          bookableAlone: true,
          name: "Lone",
        });
        await updateTestListing(solo.id, { bookableAlone: false });
        expect((await listingsTable.findById(solo.id))!.bookable_alone).toBe(
          false,
        );
      });

      test("setting bookable_alone true on a child opens its page", async () => {
        // The reverse transition never runs the orphan guard (adding a page only
        // ADDS reachability), so it always succeeds and the page opens.
        const { child } = await makeParent({
          children: [{ name: "Later Solo" }],
          parent: { name: "Picker" },
        });
        expect(await ticketPageStatus(child.slug)).toBe(404);
        await updateTestListing(child.id, { bookableAlone: true });
        expect(await ticketPageStatus(child.slug)).toBe(200);
      });
    });
  },
);
