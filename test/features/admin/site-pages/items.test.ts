import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingChildren } from "#db/listing-parents.ts";
import { addPageItem, getItemsForPage } from "#db/site-page-items.ts";
import { wasActivityLogged as wasLogged } from "#test-utils/activity-log.ts";
import {
  expectErrorFlash,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { BASE, create, findPage } from "./helpers.ts";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  describe("item manager", () => {
    const seedPage = async (slug: string) => {
      await create(slug);
      return findPage(slug);
    };

    test("adds a listing, a group, and a sub-page", async () => {
      const page = await seedPage("host");
      const listing = await createTestListing({ name: "L" });
      const group = await createTestGroup({ name: "G", slug: "g-slug" });
      const child = await seedPage("kid");

      for (const [type, id] of [
        ["listing", listing.id],
        ["group", group.id],
        ["page", child.id],
      ] as const) {
        const { response } = await adminFormPost(`${BASE}/${page.id}/items`, {
          item_id: String(id),
          item_type: type,
        });
        expectRedirect(response);
        expectFlash(response, "Added to page", true);
      }
      const items = await getItemsForPage(page.id);
      expect(items.map((i) => i.item_type)).toEqual([
        "listing",
        "group",
        "page",
      ]);
      expect(await wasLogged("Item added to page 'Name host'")).toBe(true);
    });

    test("pickers omit items already on the page", async () => {
      const page = await seedPage("pick");
      const kept = await createTestListing({ name: "Kept" });
      const added = await createTestListing({ name: "Added" });
      // An un-added group must still be offered in the group picker.
      await createTestGroup({ name: "KeptG", slug: "kg" });
      await addPageItem(page.id, "listing", added.id);
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      // The un-added listing is still offered; the added one is not.
      expect(html).toContain(`value="${kept.id}"`);
      expect(html).not.toContain(`value="${added.id}"`);
      // The un-added group is offered too.
      expect(html).toContain(">KeptG<");
    });

    test("rejects re-adding an item already on the page", async () => {
      const page = await seedPage("nodupe");
      const listing = await createTestListing({ name: "Once" });
      await addPageItem(page.id, "listing", listing.id);
      const { response } = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: String(listing.id),
        item_type: "listing",
      });
      expectErrorFlash(response, "can't be added");
      expect((await getItemsForPage(page.id)).length).toBe(1);
    });

    test("deleting a listing or group clears its page edges", async () => {
      const page = await seedPage("edges");
      const listing = await createTestListing({ name: "Doomed listing" });
      const group = await createTestGroup({ name: "Doomed group", slug: "dg" });
      await addPageItem(page.id, "listing", listing.id);
      await addPageItem(page.id, "group", group.id);
      expect((await getItemsForPage(page.id)).length).toBe(2);

      const { deleteListing } = await import("#db/listings/delete.ts");
      const { deleteGroup } = await import("#routes/admin/groups.ts");
      await deleteListing(listing.id);
      await deleteGroup(group.id);
      // No dangling edges remain pointing at the deleted targets.
      expect((await getItemsForPage(page.id)).length).toBe(0);
    });

    test("edit resolves item labels and flags a missing target", async () => {
      const page = await seedPage("labels");
      const listing = await createTestListing({ name: "Real Listing" });
      const group = await createTestGroup({ name: "Real Group", slug: "rg" });
      const child = await seedPage("kidlabel");
      // A spare unparented page keeps the sub-page picker non-empty.
      await seedPage("spare");
      // A real sub-page whose name is empty: its label stays "" (?? keeps the
      // empty string) rather than falling back to the "(missing)" placeholder.
      const blank = await createTestSitePage("blank-page", { name: "" });
      await addPageItem(page.id, "listing", listing.id);
      await addPageItem(page.id, "group", group.id);
      await addPageItem(page.id, "page", child.id);
      await addPageItem(page.id, "page", blank.id);
      // A dangling edge (its listing no longer exists) renders the fallback.
      await addPageItem(page.id, "listing", 999999);
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      expect(html).toContain("Real Listing");
      expect(html).toContain("Real Group");
      expect(html).toContain("Name kidlabel");
      // Only the dangling edge (not the empty-named listing) is "(missing)".
      expect((html.match(/\(missing\)/g) ?? []).length).toBe(1);
      // The spare page is offered in the sub-page picker.
      expect(html).toContain("Name spare");
    });

    test("offers only active listings; labels keep inactive ones named", async () => {
      const page = await seedPage("actives");
      const inactive = await createTestListing({ name: "Retired Listing" });
      await addPageItem(page.id, "listing", inactive.id);
      const { deactivateTestListing } = await import(
        "#test-utils/db-helpers/listings.ts"
      );
      await deactivateTestListing(inactive.id);
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      // The already-added inactive listing still labels its row...
      expect(html).toContain("Retired Listing");
      // ...but an inactive listing is never offered as a new option, and
      // neither is a renewal tier (a normal public link would take payment
      // without extending the site).
      expect(html).not.toContain(`value="${inactive.id}"`);
      const tier = await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        name: "Tier Listing",
        purchaseOnly: true,
      });
      const html2 = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      expect(html2).not.toContain(`value="${tier.id}"`);
      // A child listing's public page 404s by construction (a booking can
      // never start from a child, I3), so it is never offered either — while
      // its parent still is.
      const parent = await createTestListing({ name: "Parent Listing" });
      const child = await createTestListing({ name: "Child Listing" });
      await listingChildren.setIds(parent.id, [child.id]);
      const html3 = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      expect(html3).toContain(">Parent Listing<");
      expect(html3).not.toContain(">Child Listing<");
      // And the server revalidation rejects all three.
      const other = await seedPage("actives-2");
      for (const id of [inactive.id, tier.id, child.id]) {
        const { response } = await adminFormPost(`${BASE}/${other.id}/items`, {
          item_id: String(id),
          item_type: "listing",
        });
        expectErrorFlash(response, "can't be added");
      }
      expect((await getItemsForPage(other.id)).length).toBe(0);
    });

    test("rejects an ineligible / invalid target", async () => {
      const page = await seedPage("guarded");
      // A real listing id that doesn't exist → ineligible (not "invalid").
      const bad = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: "9999",
        item_type: "listing",
      });
      expectErrorFlash(bad.response, "can't be added");
      // A bad item_type with an otherwise-valid id → invalid-item (the type
      // check alone must reject, independent of the id).
      const badType = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: "5",
        item_type: "nonsense",
      });
      expectErrorFlash(badType.response, "Please choose something to add");
      // A missing id with a valid type → invalid-item (the id check alone).
      const noId = await adminFormPost(`${BASE}/${page.id}/items`, {
        item_id: "",
        item_type: "listing",
      });
      expectErrorFlash(noId.response, "Please choose something to add");
      expect((await getItemsForPage(page.id)).length).toBe(0);
    });

    test("rejects nesting a page that already has a parent", async () => {
      const a = await seedPage("pa");
      const b = await seedPage("pb");
      const child = await seedPage("pc");
      await addPageItem(a.id, "page", child.id);
      // b's picker won't offer child, and the server revalidation rejects it.
      const { response } = await adminFormPost(`${BASE}/${b.id}/items`, {
        item_id: String(child.id),
        item_type: "page",
      });
      expectRedirect(response);
      expect((await getItemsForPage(b.id)).length).toBe(0);
    });

    test("removes an item and reorders within a page", async () => {
      const page = await seedPage("rmpage");
      const l1 = await createTestListing({ name: "L1" });
      const l2 = await createTestListing({ name: "L2" });
      const l3 = await createTestListing({ name: "L3" });
      await addPageItem(page.id, "listing", l1.id);
      await addPageItem(page.id, "listing", l2.id);
      await addPageItem(page.id, "listing", l3.id);
      const ids = async (): Promise<number[]> =>
        (await getItemsForPage(page.id)).map((i) => i.item_id);

      // Move the middle item up (index 1 → 0): l2, l1, l3.
      const up = await adminFormPost(
        `${BASE}/${page.id}/items/listing/${l2.id}/move-up`,
        {},
      );
      expectFlash(up.response, "Order updated", true);
      expect(await ids()).toEqual([l2.id, l1.id, l3.id]);

      // Move l1 (now index 1) down: l2, l3, l1.
      await adminFormPost(
        `${BASE}/${page.id}/items/listing/${l1.id}/move-down`,
        {},
      );
      expect(await ids()).toEqual([l2.id, l3.id, l1.id]);

      const { response } = await adminFormPost(
        `${BASE}/${page.id}/items/listing/${l1.id}/remove`,
        {},
      );
      expectRedirect(response);
      expectFlash(response, "Removed from page", true);
      expect(await ids()).toEqual([l2.id, l3.id]);
      expect(await wasLogged("Item removed from page 'Name rmpage'")).toBe(
        true,
      );
    });

    test("item move route 404s on a bad type", async () => {
      const page = await seedPage("bad-move-ref");
      const { response } = await adminFormPost(
        `${BASE}/${page.id}/items/bogus/1/move-up`,
        {},
      );
      expect(response.status).toBe(404);
    });

    test("item routes 404 on a bad ref or missing page", async () => {
      const page = await seedPage("refs");
      expect(
        (await adminFormPost(`${BASE}/${page.id}/items/bogus/1/remove`, {}))
          .response.status,
      ).toBe(404);
      // Removing an item from a page that doesn't exist 404s too.
      expect(
        (await adminFormPost(`${BASE}/9999/items/listing/1/remove`, {}))
          .response.status,
      ).toBe(404);
      expect(
        (
          await adminFormPost(`${BASE}/9999/items`, {
            item_id: "1",
            item_type: "listing",
          })
        ).response.status,
      ).toBe(404);
    });
  });
});
