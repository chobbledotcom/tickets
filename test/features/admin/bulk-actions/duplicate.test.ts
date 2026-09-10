import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import {
  getGroupPackagePrices,
  getListingsByGroupId,
  groups,
} from "#db/groups.ts";
import { getStoredListingWithCount } from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  getTestPackagePrices,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, getBulkActionForm } from "#test-utils/session.ts";

const getDuplicateForm = getBulkActionForm("duplicate");

describeWithEnv("Admin bulk actions — duplicate", { db: true }, () => {
  describe("GET /admin/groups/:id/bulk-actions/duplicate", () => {
    test("shows an empty-state message when the group has no listings", async () => {
      const group = await createTestGroup({ name: "Empty" });

      const html = await getDuplicateForm(group.id);

      expect(html).toContain("This group has no listings");
    });

    test("renders the duplicate form with listing preview data", async () => {
      // Sits beside the Cucumber story `catalogue.copy-a-group-of-listings`,
      // which opens the form and submits it. The story exercises the GET route
      // indirectly, but `fillInAndSend` reads fields by name — so a regression
      // that stopped rendering the preview section (while the form fields still
      // sent) would pass the story. This GET test pins the route's duty to load
      // the group's members and pass them to the template.
      const group = await createTestGroup({ name: "Original" });
      await createTestListing({ groupId: group.id, name: "Spring Workshop" });

      const html = await getDuplicateForm(group.id);

      expect(html).toContain("Spring Workshop");
      expect(html).toContain("Original (copy)");
    });
  });

  describe("POST /admin/groups/:id/bulk-actions/duplicate", () => {
    test("syncs listing_prices for cloned listings", async () => {
      // Clones are inserted via insertStatement in a batch (bypassing the
      // listingsTable wrapper), so the duplicate flow must sync their price rows.
      const group = await createTestGroup({ name: "Priced Source" });
      await createTestListing({
        groupId: group.id,
        name: "Priced Item",
        unitPrice: 850,
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Priced",
          name_replace: "Cloned",
          new_name: "Priced Copy",
        },
      );
      expect(response.status).toBe(302);
      // A clean duplicate reports plain success — no dropped-children caveat —
      // and logs the copy against the source group.
      expectFlash(
        response,
        "Duplicated 'Priced Source' to 'Priced Copy' (1 listing(s))",
      );
      expect(await activityMessages()).toContain(
        "Group 'Priced Source' duplicated to 'Priced Copy' with 1 listing(s)",
      );

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Priced Copy",
      )!;
      const clone = (await getListingsByGroupId(newGroup.id))[0]!;
      const rows = await queryAll<{ price_type: string; unit_price: number }>(
        "SELECT price_type, unit_price FROM listing_prices WHERE listing_id = ?",
        [clone.id],
      );
      expect(rows).toEqual([{ price_type: "base", unit_price: 850 }]);
    });

    test("clones a use-defaults listing from its stored values, not inherited defaults", async () => {
      // A Hidden=Yes default is live while we duplicate the group.
      await settings.update.listingDefaults({ hidden: true });
      const group = await createTestGroup({ name: "Inherits" });
      await createTestListing({
        groupId: group.id,
        hidden: false,
        name: "Inheriting member",
        useDefaults: true,
      });

      await adminFormPost(`/admin/groups/${group.id}/bulk-actions/duplicate`, {
        name_find: "Inheriting",
        name_replace: "Cloned",
        new_name: "Inherits copy",
      });

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Inherits copy",
      )!;
      const clone = (await getListingsByGroupId(newGroup.id))[0]!;
      // The clone's OWN stored hidden is the source's stored false, not the
      // Hidden=Yes default — so clearing the default later won't strand it.
      expect((await getStoredListingWithCount(clone.id))?.hidden).toBe(false);
    });

    test("copies dates verbatim when no date replacement is given", async () => {
      // The Cucumber story `catalogue.copy-keeps-name-and-date-when-no-replacements`
      // proves the actor-facing claim through the rendered form. This direct
      // test stays for the date-arithmetic contract: the empty-date-replacement
      // branch must leave the stored ISO unchanged, byte for byte — a property
      // a story asserting only the day cannot pin down (the time-of-day depends
      // on timezone/DST).
      const group = await createTestGroup({ name: "Verbatim" });
      const sourceListing = await createTestListing({
        date: "2026-05-01T10:00",
        groupId: group.id,
        name: "Untouched",
      });

      // A name replacement is still required — names are unique, so a clone may
      // not keep the source's name — but an empty date replacement leaves the
      // date verbatim.
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          name_find: "Untouched",
          name_replace: "Renamed",
          new_name: "Verbatim Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Verbatim Copy",
      );
      expect(newGroup).toBeDefined();
      const newListings = await getListingsByGroupId(newGroup!.id);
      expect(newListings[0]!.name).toBe("Renamed");
      expect(newListings[0]!.date).toBe(sourceListing.date);
    });

    test("shifts cloned listing dates by the given day offset", async () => {
      // The Cucumber story `catalogue.copy-creates-independent-group` proves the
      // actor-facing claim through the rendered form, but Cucumber runs do not
      // feed the deterministic coverage gate. This direct test pins the
      // non-empty `date_find`/`date_replace` branch of
      // `handleDuplicateGroupPost` — `computeDayOffset` → `shiftUtcIsoByDays`
      // — so a regression that ignored the submitted date shift would fail here.
      const group = await createTestGroup({ name: "Shift Src" });
      const source = await createTestListing({
        date: "2026-04-16T09:00",
        groupId: group.id,
        name: "Shift Me",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "2026-04-16",
          date_replace: "2026-04-23",
          name_find: "Shift",
          name_replace: "Moved",
          new_name: "Shift Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Shift Copy",
      );
      expect(newGroup).toBeDefined();
      const clone = (await getListingsByGroupId(newGroup!.id))[0]!;
      expect(clone.name).toBe("Moved Me");
      // 7 days forward, same time-of-day — the stored date is the shifted
      // UTC ISO, not the source's unchanged value.
      expect(clone.date).toBe("2026-04-23T09:00:00.000Z");
      expect(clone.date).not.toBe(source.date);
    });

    test("duplicates a large group without tripping the transaction round-trip guard", async () => {
      // 16 listings would be 1 + 16 + 16 = 33 statements in an interactive
      // transaction (guard fires at 30); the single-batch clone must stay clear
      // of it and land every membership row.
      const group = await createTestGroup({ name: "Big" });
      for (let i = 0; i < 16; i++) {
        await createTestListing({ groupId: group.id, name: `Listing ${i}` });
      }

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          date_find: "",
          date_replace: "",
          // "Listing N" → "Clone N" keeps every clone name unique.
          name_find: "Listing",
          name_replace: "Clone",
          new_name: "Big Copy",
        },
      );

      expect(response.status).toBe(302);
      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Big Copy",
      );
      expect(newGroup).toBeDefined();
      expect((await getListingsByGroupId(newGroup!.id)).length).toBe(16);
    });

    test("copies the package flag, hide option, and remapped member overrides", async () => {
      const { getGroupDayPrices, getListingDayPrices } = await import(
        "#db/listing-prices.ts"
      );
      const group = await createTestGroup({
        isPackage: true,
        name: "Pkg Source",
      });
      const listing = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        groupId: group.id,
        listingType: "daily",
        maxQuantity: 4,
        name: "Member",
        unitPrice: 1000,
      });
      // Set a package price override + quantity + per-day override + hide flag
      // on the source group.
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        description: "",
        hide_package_listings: "1",
        is_package: "1",
        max_attendees: "0",
        name: "Pkg Source",
        [`package_day_price_${listing.id}_2`]: "9.00",
        [`package_price_${listing.id}`]: "30.00",
        [`package_qty_${listing.id}`]: "4",
        slug: group.slug,
        terms_and_conditions: "",
      });

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/bulk-actions/duplicate`,
        {
          name_find: "Member",
          name_replace: "Cloned Member",
          new_name: "Pkg Copy",
        },
      );
      expect(response.status).toBe(302);

      const newGroup = (await groups.cache.getAll()).find(
        (g) => g.name === "Pkg Copy",
      )!;
      expect(newGroup.is_package).toBe(true);
      expect(newGroup.hide_package_listings).toBe(true);
      const newListing = (await getListingsByGroupId(newGroup.id))[0]!;
      expect(newListing.id).not.toBe(listing.id);
      // The clone keeps its OWN per-day-count prices: they are no longer a
      // listings column, so the duplicate carries them through as day_count rows.
      expect(await getListingDayPrices(newListing.id)).toEqual({
        1: 1000,
        2: 1800,
      });
      const prices = await getTestPackagePrices(newGroup.id);
      expect(prices.get(newListing.id)).toBe(3000);
      const newRows = await getGroupPackagePrices(newGroup.id);
      expect(newRows[0]!.quantity).toBe(4);
      // The per-day override is rewritten under the NEW group id and clone id
      // (its price_id embeds the group), so the copy prices identically.
      const newDayPrices = await getGroupDayPrices(newGroup.id);
      expect(newDayPrices.get(newListing.id)?.get(2)).toBe(900);
      // The source override is untouched.
      const sourceRows = await getGroupPackagePrices(group.id);
      expect(sourceRows[0]!.package_price).toBe(3000);
      expect(sourceRows[0]!.quantity).toBe(4);
      expect((await getGroupDayPrices(group.id)).get(listing.id)?.get(2)).toBe(
        900,
      );
    });

    test("returns 404 when the source group does not exist", async () => {
      const { response } = await adminFormPost(
        "/admin/groups/999999/bulk-actions/duplicate",
        { new_name: "Orphan" },
      );
      expect(response.status).toBe(404);
    });
  });
});
