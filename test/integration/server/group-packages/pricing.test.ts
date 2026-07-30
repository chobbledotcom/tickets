/**
 * What the group's own edit form saves and shows back: the package flag, a
 * price and quantity for each thing inside, per-day prices for the ones booked
 * by the day, and what it does with a figure nobody could have meant.
 *
 * Sits beside the story `@story:bookings.selling-things-as-one-bundle`: these
 * own the branch cover, and the invariants that have no journey behind them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupPackagePrices, groups } from "#shared/db/groups.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestGroup,
  getTestPackagePrices,
} from "#test-utils/db-helpers/groups.ts";
// jscpd:ignore-start
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { editFields, member } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server (admin group packages) — prices and quantities",
  { db: true },
  () => {
    test("create POST persists the is_package flag", async () => {
      const { response } = await adminFormPost("/admin/groups", {
        is_package: "1",
        max_attendees: "0",
        name: "Bundle",
        terms_and_conditions: "",
      });
      expect(response.status).toBe(302);
      const allGroups = await groups.cache.getAll();
      expect(allGroups[allGroups.length - 1]!.is_package).toBe(true);
    });

    test("edit POST saves is_package, per-listing prices and quantities", async () => {
      const group = await createTestGroup({ name: "Pkg", slug: "pkg" });
      const a = await member(group, "A");
      const b = await member(group, "B");

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/edit`,
        {
          ...editFields("Pkg", "pkg"),
          is_package: "1",
          [`package_price_${a.id}`]: "12.50",
          [`package_price_${b.id}`]: "",
          [`package_qty_${a.id}`]: "2",
          // b omits package_qty → defaults to 1.
        },
      );
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "Group updated",
        true,
      )(response);

      const saved = (await groups.table.read.one({ id: group.id }))!;
      expect(saved.is_package).toBe(true);
      const prices = await getTestPackagePrices(group.id);
      expect(prices.get(a.id)).toBe(1250);
      // Blank input is stored as 0 (no override), so it's absent from the map.
      expect(prices.has(b.id)).toBe(false);
      const rows = await getGroupPackagePrices(group.id);
      const qty = new Map(rows.map((r) => [r.listing_id, r.quantity]));
      expect(qty.get(a.id)).toBe(2);
      expect(qty.get(b.id)).toBe(1);
    });

    test("edit POST saves per-day prices for customisable members and the form round-trips them", async () => {
      const { getGroupDayPrices } = await import(
        "#shared/db/listing-prices.ts"
      );
      const group = await createTestGroup({ name: "DayPkg", slug: "day-pkg" });
      const flex = await member(group, "Flex", {
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        listingType: "daily",
        unitPrice: 1000,
      });
      const plain = await member(group, "Plain");

      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("DayPkg", "day-pkg"),
        is_package: "1",
        // 2-day span repriced; 1-day left blank ("use the listing's own price").
        [`package_day_price_${flex.id}_1`]: "",
        [`package_day_price_${flex.id}_2`]: "15.00",
        [`package_price_${flex.id}`]: "",
        [`package_price_${plain.id}`]: "",
      });

      const saved = await getGroupDayPrices(group.id);
      expect(saved.get(flex.id)?.get(2)).toBe(1500);
      expect(saved.get(flex.id)?.has(1)).toBe(false);
      expect(saved.has(plain.id)).toBe(false);

      // The edit page renders a per-day input per offered span for the
      // customisable member only, pre-filled with the saved override.
      const html = await expectHtmlResponse(
        await adminGet(`/admin/groups/${group.id}/edit`),
        200,
      );
      expect(html).toContain(`name="package_day_price_${flex.id}_1"`);
      expect(html).toContain(`name="package_day_price_${flex.id}_2"`);
      expect(html).toContain('value="15.00"');
      expect(html).not.toContain(`package_day_price_${plain.id}_`);

      // Re-saving without the day inputs clears the overrides (full replace).
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("DayPkg", "day-pkg"),
        is_package: "1",
        [`package_price_${flex.id}`]: "",
        [`package_price_${plain.id}`]: "",
      });
      expect((await getGroupDayPrices(group.id)).size).toBe(0);
    });

    test("edit POST defaults a malformed or out-of-range quantity to 1", async () => {
      const group = await createTestGroup({ name: "BadQty", slug: "bad-qty" });
      const prefix = await member(group, "Prefix");
      const zero = await member(group, "Zero");
      const huge = await member(group, "Huge");

      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("BadQty", "bad-qty"),
        is_package: "1",
        [`package_price_${prefix.id}`]: "1.00",
        [`package_price_${zero.id}`]: "1.00",
        [`package_price_${huge.id}`]: "1.00",
        // parseInt would read 2 from "2abc"; 0 is below the minimum; the 20-digit
        // value overflows the safe-integer range — each defaults to 1.
        [`package_qty_${prefix.id}`]: "2abc",
        [`package_qty_${zero.id}`]: "0",
        [`package_qty_${huge.id}`]: "99999999999999999999",
      });

      const rows = await getGroupPackagePrices(group.id);
      const qty = new Map(rows.map((r) => [r.listing_id, r.quantity]));
      expect(qty.get(prefix.id)).toBe(1);
      expect(qty.get(zero.id)).toBe(1);
      expect(qty.get(huge.id)).toBe(1);
    });

    test("edit POST persists the hide-package-listings flag", async () => {
      const group = await createTestGroup({ name: "HideG", slug: "hide-g" });
      await member(group, "HM");

      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("HideG", "hide-g"),
        hide_package_listings: "1",
        is_package: "1",
      });
      expect(
        (await groups.table.read.one({ id: group.id }))!.hide_package_listings,
      ).toBe(true);
    });

    test("edit POST treats a negative or non-numeric package price as no override", async () => {
      const group = await createTestGroup({ name: "Bad", slug: "bad" });
      const a = await member(group, "Neg");
      const b = await member(group, "NaN");

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/edit`,
        {
          ...editFields("Bad", "bad"),
          is_package: "1",
          [`package_price_${a.id}`]: "-5",
          [`package_price_${b.id}`]: "abc",
        },
      );
      expect(response.status).toBe(302);
      // Both invalid inputs store 0 (no override), so neither appears in the map.
      expect((await getTestPackagePrices(group.id)).size).toBe(0);
    });

    test("edit POST rejects a leading-numeric typo instead of parsing a prefix", async () => {
      const group = await createTestGroup({ name: "Typo", slug: "typo" });
      const a = await member(group, "Letters");
      const b = await member(group, "Comma");

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/edit`,
        {
          ...editFields("Typo", "typo"),
          is_package: "1",
          // parseFloat would turn these into a real 12 / 1 override; the strict
          // parser treats the whole non-numeric string as "no override" (0).
          [`package_price_${a.id}`]: "12abc",
          [`package_price_${b.id}`]: "1,50",
        },
      );
      expect(response.status).toBe(302);
      expect((await getTestPackagePrices(group.id)).size).toBe(0);
    });

    test("edit POST rejects an out-of-range package price as no override", async () => {
      const group = await createTestGroup({ name: "Huge", slug: "huge" });
      const a = await member(group, "Big");

      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/edit`,
        {
          ...editFields("Huge", "huge"),
          is_package: "1",
          // 14 nines scales past Number.MAX_SAFE_INTEGER in minor units, so it would
          // store a lossy amount — rejected to 0 (no override) instead.
          [`package_price_${a.id}`]: "99999999999999",
        },
      );
      expect(response.status).toBe(302);
      expect((await getTestPackagePrices(group.id)).size).toBe(0);
    });

    test("edit POST without is_package clears the package flag and overrides", async () => {
      const group = await createTestGroup({ name: "Clr", slug: "clr" });
      const a = await member(group, "CA");

      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("Clr", "clr"),
        is_package: "1",
        [`package_price_${a.id}`]: "9.00",
      });
      expect((await groups.table.read.one({ id: group.id }))!.is_package).toBe(
        true,
      );

      // Re-submit without the checkbox: flag clears and overrides reset to 0.
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("Clr", "clr"),
        [`package_price_${a.id}`]: "9.00",
      });
      const saved = (await groups.table.read.one({ id: group.id }))!;
      expect(saved.is_package).toBe(false);
      expect((await getTestPackagePrices(group.id)).size).toBe(0);
    });

    test("edit GET renders the package price table pre-filled from overrides", async () => {
      const group = await createTestGroup({ name: "Show", slug: "show" });
      const a = await member(group, "Shown A");
      // A second member with no override exercises the "blank input" branch.
      const b = await member(group, "Shown B");
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        ...editFields("Show", "show"),
        is_package: "1",
        [`package_price_${a.id}`]: "7.00",
        [`package_price_${b.id}`]: "",
        [`package_qty_${a.id}`]: "5",
      });

      const html = await expectHtmlResponse(
        await adminGet(`/admin/groups/${group.id}/edit`),
        200,
        "Package prices",
        "Shown A",
      );
      expect(html).toContain(`name="package_price_${a.id}"`);
      expect(html).toContain('value="7.00"');
      // The override-free member renders an empty value, falling back to base price.
      expect(html).toContain(`name="package_price_${b.id}"`);
      // Per-package quantity inputs render, pre-filled with the saved quantity.
      expect(html).toContain(`name="package_qty_${a.id}"`);
      expect(html).toContain('value="5"');
    });

    test("edit GET shows the empty-group prompt when there are no listings", async () => {
      const group = await createTestGroup({ name: "Empty", slug: "empty" });
      await expectHtmlResponse(
        await adminGet(`/admin/groups/${group.id}/edit`),
        200,
        "Add listings to this group to set their package prices.",
      );
    });
  },
);
