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
import { listingChildren } from "#shared/db/listing-parents.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
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
} from "#test-utils/parents.ts";
import { adminGet } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

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
    describe("/order gallery", () => {
      test("offers a bookable_alone child as a selectable card", async () => {
        await enablePublicSite();
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
        await enablePublicSite();
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

    describe("flag transitions on listing save (no orphaned add-on)", () => {
      test("clearing bookable_alone on a NON-child listing is a no-op guard", async () => {
        // The flag is inert for a listing with no parents, so clearing it never
        // runs the reachability guard — the save just succeeds.
        const solo = await createTestListing({
          bookableAlone: true,
          name: "Lone",
        });
        await updateTestListing(solo.id, { bookableAlone: false });
        expect(
          (await listingsTable.read.pick(["bookable_alone"]).one({
            id: solo.id,
          }))!.bookable_alone,
        ).toBe(false);
      });
    });
  },
);
