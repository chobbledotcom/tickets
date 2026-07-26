import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ctxStandInNames,
  getTicketContext,
  loadPagePackage,
  ticketGalleryTarget,
} from "#routes/public/ticket-payment.ts";
import { buildBookingTree } from "#shared/booking/build-tree.ts";
import { buildTicketListing } from "#shared/booking/model.ts";
import {
  aggregateNodeQuantities,
  buildOrderLines,
  nodeQuantitiesFor,
} from "#shared/booking/order-lines.ts";
import { setGroupPackageMembers, setListingGroups } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import type { ListingWithCount } from "#shared/types.ts";
import { treePackage } from "#test/test-utils/package-cap-fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

/** Per-path line assembly and the package-aware ticket context, split from
 * ticket-payment.test.ts to stay under the file-size lint. */
describeWithEnv(
  "routes > public > ticket-payment (packages)",
  { db: true },
  () => {
    describe("ctxStandInNames", () => {
      test("conceals a hidden package's members and their children", () => {
        const standIns = ctxStandInNames({
          childrenByParentId: new Map([
            [
              1,
              [
                buildTicketListing(
                  testListingWithCount({ id: 9 }),
                  false,
                  undefined,
                ),
              ],
            ],
          ]),
          packages: [
            {
              ...treePackage(7, [1, 2]),
              description: "",
              hideListings: true,
              name: "Mystery Box",
              slug: "myst1",
              terms: "",
            },
          ],
        });
        // Member 1's child 9 is concealed too; member 2 has no children entry.
        expect([...standIns.byListingId]).toEqual([
          [1, "Mystery Box"],
          [9, "Mystery Box"],
          [2, "Mystery Box"],
        ]);
        // The bundle's own tagged lines rename through its group id.
        expect([...standIns.byGroupId]).toEqual([[7, "Mystery Box"]]);
      });

      test("names nothing for a package that shows its listings", () => {
        const standIns = ctxStandInNames({
          childrenByParentId: new Map(),
          packages: [
            {
              ...treePackage(7, [1]),
              description: "",
              name: "Open Box",
              slug: "open1",
              terms: "",
            },
          ],
        });
        expect(standIns.byGroupId.size).toBe(0);
        expect(standIns.byListingId.size).toBe(0);
      });
    });

    describe("buildOrderLines", () => {
      // Exhaustive unit-price precedence lives in test/shared/booking/price-tree.test.ts; here
      // we cover assembly (filter + field mapping) and that each line is priced by
      // its own tree PATH (a package OVERRIDE scoped to that member line).
      /** Order lines for a standalone one-listing page at the given quantity. */
      const buildStandalone = (
        listing: ListingWithCount,
        quantity: number,
      ): CheckoutItem[] => {
        const tree = buildBookingTree({
          listings: [buildTicketListing(listing, false, undefined)],
          slugs: [listing.slug],
        });
        const nodeQuantities = nodeQuantitiesFor(
          tree,
          new Map([[listing.id, quantity]]),
          new Map(),
        );
        return buildOrderLines(
          tree,
          nodeQuantities,
          aggregateNodeQuantities(tree, nodeQuantities),
          new Map(),
          1,
        );
      };

      test("drops zero-quantity listings and assembles the checkout line", () => {
        const listing = testListingWithCount({
          id: 9,
          name: "Widget",
          slug: "wdgt1",
          unit_price: 500,
        });
        expect(buildStandalone(listing, 2)).toEqual([
          {
            listingId: 9,
            name: "Widget",
            quantity: 2,
            slug: "wdgt1",
            unitPrice: 500,
          },
        ]);
        expect(buildStandalone(listing, 0)).toEqual([]);
      });

      test("prices each line by its own path (package override on the member line)", () => {
        const listing = testListingWithCount({
          id: 7,
          name: "Member",
          slug: "mmbr7",
          unit_price: 500,
        });
        const tree = buildBookingTree({
          listings: [buildTicketListing(listing, false, undefined)],
          packages: [treePackage(3, [7], { prices: new Map([[7, 1200]]) })],
          slugs: ["pkg"],
        });
        const nodeQuantities = nodeQuantitiesFor(
          tree,
          new Map(),
          new Map([[3, 1]]),
        );
        const items = buildOrderLines(
          tree,
          nodeQuantities,
          aggregateNodeQuantities(tree, nodeQuantities),
          new Map(),
          1,
        );
        // The member line carries ITS package's id and ITS override price.
        expect(items).toEqual([
          {
            listingId: 7,
            name: "Member",
            packageGroupId: 3,
            quantity: 1,
            slug: "mmbr7",
            unitPrice: 1200,
          },
        ]);
      });
    });

    describe("loadPagePackage / getTicketContext packages", () => {
      test("ticketGalleryTarget chooses the page's one header entity", async () => {
        const group = await createTestGroup({ name: "Gallery group" });
        const first = buildTicketListing(
          testListingWithCount({ id: 11 }),
          false,
          undefined,
        );
        const second = buildTicketListing(
          testListingWithCount({ id: 12 }),
          false,
          undefined,
        );

        expect(ticketGalleryTarget([first], undefined)).toEqual({
          id: 11,
          type: "listing",
        });
        expect(ticketGalleryTarget([first, second], undefined)).toBeNull();
        expect(ticketGalleryTarget([first, second], group)).toEqual({
          id: group.id,
          type: "group",
        });
      });

      test("loadPagePackage keeps overrides incl. free, skips no-override, and every quantity", async () => {
        const group = await createTestGroup({ isPackage: true, name: "Pk" });
        const a = await createTestListing({ name: "PA" });
        const b = await createTestListing({ name: "PB" });
        const c = await createTestListing({ name: "PC" });
        await setListingGroups(a.id, [group.id]);
        await setListingGroups(b.id, [group.id]);
        await setListingGroups(c.id, [group.id]);
        await setGroupPackageMembers(group.id, [
          { listingId: a.id, price: 1500, quantity: 2 },
          { listingId: b.id, price: 0 },
          { listingId: c.id, price: null },
        ]);

        const pkg = await loadPagePackage(group, [a.id, b.id, c.id]);
        expect(pkg.groupId).toBe(group.id);
        expect(pkg.memberListingIds).toEqual([a.id, b.id, c.id]);
        const { prices, quantities } = pkg;
        // A positive override and an explicit free (0) are both real prices kept
        // in the map; a null (no override) member is skipped so it falls back to
        // the listing's own price.
        expect(prices.get(a.id)).toBe(1500);
        expect(prices.get(b.id)).toBe(0);
        expect(prices.has(c.id)).toBe(false);
        // Quantities cover every member, including the override-free one.
        expect(quantities.get(a.id)).toBe(2);
        expect(quantities.get(b.id)).toBe(1);
        expect(quantities.get(c.id)).toBe(1);
      });

      test("getTicketContext exposes the package (group id + prices) for a package group", async () => {
        await settings.update.terms("Global terms");
        const group = await createTestGroup({
          isPackage: true,
          name: "Ctx",
          termsAndConditions: "Package terms",
        });
        const a = await createTestListing({ name: "CA" });
        await setListingGroups(a.id, [group.id]);
        await setGroupPackageMembers(group.id, [
          { listingId: a.id, price: 2000 },
        ]);

        const ctx = await getTicketContext(
          [
            buildTicketListing(
              testListingWithCount({ id: a.id }),
              false,
              undefined,
            ),
          ],
          group,
        );
        expect(ctx.packages).toHaveLength(1);
        expect(ctx.packages[0]!.groupId).toBe(group.id);
        expect(ctx.packages[0]!.prices.get(a.id)).toBe(2000);
        expect(ctx.packageMemberGroupIds.get(a.id)).toEqual([group.id]);
        expect(ctx.terms).toBe("Package terms");
      });

      test("getTicketContext carries no packages for a non-package group", async () => {
        await settings.update.terms("Global terms");
        const group = await createTestGroup({ name: "Plain" });
        const ctx = await getTicketContext([], group);
        expect(ctx.packages).toEqual([]);
        expect(ctx.terms).toBe("Global terms");
      });
    });
  },
);
