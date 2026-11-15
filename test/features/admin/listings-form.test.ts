import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import { listingAttributeOptions } from "#db/attributes.ts";
import { getDb } from "#db/client.ts";
import { getGroupPackagePrices } from "#db/groups.ts";
import { getListingDayPrices } from "#db/listing-prices.ts";
import { deleteListing } from "#db/listings/delete.ts";
import {
  getListingWithCount,
  getStoredListingWithCount,
} from "#db/listings/records.ts";
import { t } from "#i18n";
import { buildUpdateListingResource } from "#routes/admin/listings-form.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { listingRecord } from "#shared/records/listings.ts";
import { listingFormView } from "#templates/fields/listing.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, apiRequest } from "#test-utils/session.ts";

import {
  createListing,
  listingForm,
  saveListingEdit,
  tryCreateListing,
  updateListing,
} from "./listings-form/helpers.ts";

describeWithEnv("listings form", { db: true }, () => {
  describe("create", () => {
    test("a minimal form makes a free standard listing open on every day", () =>
      (async () => {
        const row = await createListing();
        expect(row.name).toBe("Parsed listing");
        expect(row.listing_type).toBe("standard");
        expect(row.unit_price).toBe(0);
        expect(row.max_attendees).toBe(50);
        expect(row.max_quantity).toBe(5);
        expect(row.bookable_days).toEqual([...VALID_DAY_NAMES]);
        expect(row.closes_at).toBeNull();
      })());

    test("refuses a quantity below the field's declared minimum", async () => {
      for (const [field, value] of [
        ["max_attendees", "0"],
        ["min_quantity", "0"],
      ] as const) {
        const result = await tryCreateListing({ [field]: value });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(
            field === "max_attendees"
              ? "Max attendees must be 1 or greater"
              : "Min tickets per purchase must be 1 or greater",
          );
        }
      }
    });

    test("accepts quantities at the declared minimum", async () => {
      const row = await createListing({
        max_attendees: "1",
        max_quantity: "1",
        min_quantity: "1",
      });
      expect(row.max_attendees).toBe(1);
      expect(row.max_quantity).toBe(1);
      expect(row.min_quantity).toBe(1);
    });

    test("a zero unit price stays an explicit zero", async () => {
      const row = await createListing({ unit_price: "0" });
      expect(row.unit_price).toBe(0);
    });

    test("a priced form stores the currency's minor units", async () => {
      const row = await createListing({
        max_price: "12.5",
        unit_price: "12.34",
      });
      expect(row.unit_price).toBe(1234);
      expect(row.max_price).toBe(1250);
    });

    test("datetimes normalize to UTC, and blanks stay blank", async () => {
      const dated = await createListing({
        closes_at_date: "2026-06-15",
        closes_at_time: "14:30",
        date_date: "2026-03-01",
        date_time: "09:05",
      });
      expect(dated.closes_at).toBe("2026-06-15T14:30:00.000Z");
      expect(dated.date).toBe("2026-03-01T09:05:00.000Z");

      const blank = await createListing({ name: "Undated" });
      expect(blank.closes_at).toBeNull();
      expect(blank.date).toBe("");
    });

    test("chosen bookable days are kept as chosen, even a single one", async () => {
      for (const days of [["Monday", "Thursday"], ["Friday"]]) {
        expect(
          (await createListing({ bookable_days: days, name: days.join(" ") }))
            .bookable_days,
        ).toEqual(days);
      }
    });

    test("a listing with no closing date stores nothing in that column", async () => {
      const row = await createListing();
      const stored = await getDb().execute({
        args: [row.id],
        sql:
          "SELECT listing.closes_at FROM listings AS listing " +
          "WHERE listing.id = ?",
      });
      expect(stored.rows[0]!.closes_at).toBeNull();
    });

    test("duplicating a listing copies the source's attribute choices", async () => {
      const attribute = await createTestAttributeWithOptions("Size", [
        "Small",
        "Large",
      ]);
      const source = await createListing({ name: "Source" });
      await assignTestAttributeOptions(source.id, attribute.options);

      const copy = await createListing({
        duplicated_from: String(source.id),
        name: "Copy",
      });
      expect(await listingAttributeOptions.getIds(copy.id)).toEqual(
        attribute.options.map((option) => option.id),
      );

      const fresh = await createListing({ name: "Fresh" });
      expect(await listingAttributeOptions.getIds(fresh.id)).toEqual([]);
    });

    test("duplicating a package member refuses a copied pick count above the copy's cap", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Duplicate cap pkg",
      });
      const source = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Picky source",
      });
      const priced = await apiRequest(`/api/admin/groups/${group.id}`, {
        body: {
          is_package: true,
          package_members: [
            { listing_id: source.id, price: null, quantity: 5 },
          ],
        },
        method: "PUT",
      });
      expect(priced.status).toBe(200);

      const result = await tryCreateListing({
        duplicated_from: String(source.id),
        group_ids: String(group.id),
        max_quantity: "2",
        name: "Undercapped copy",
      });
      expect(result).toEqual({
        error: t("error.package_member_cap", {
          max_quantity: 2,
          name: "Undercapped copy",
          quantity: 5,
        }),
        ok: false,
      });
      const { getAllListings } = await import("#db/listings/records.ts");
      expect(
        (await getAllListings()).some(
          (listing) => listing.name === "Undercapped copy",
        ),
      ).toBe(false);
    });

    test("day prices are read for days one up to the duration only", async () => {
      const row = await createListing({
        day_price_1: "10",
        day_price_2: "",
        day_price_3: "30",
        day_price_4: "40",
        duration_days: "3",
      });
      expect(await getListingDayPrices(row.id)).toEqual({ 1: 1000, 3: 3000 });
    });

    test("without a duration, only the single-day price is read", async () => {
      const row = await createListing({
        day_price_1: "15",
        day_price_2: "20",
      });
      expect(await getListingDayPrices(row.id)).toEqual({ 1: 1500 });
    });

    for (const [name, boxes, error] of [
      [
        "an impossible date is refused before anything is saved",
        { date_date: "2026-02-30", date_time: "10:00" },
        "Please enter a valid date and time",
      ],
      [
        "an unreadable day price rejects the save with a plain message",
        { day_price_1: "abc", duration_days: "2" },
        "Enter a valid day price for each duration, or leave it blank.",
      ],
    ] as const) {
      test(name, async () => {
        expect(await tryCreateListing(boxes)).toEqual({ error, ok: false });
      });
    }

    test("ticked groups are saved; unticked junk ids are not", async () => {
      const group = await createTestGroup({ name: "Form group" });
      const row = await createListing({
        group_ids: [String(group.id), "0", "-4"],
      });
      const links = await getDb().execute({
        args: [row.id],
        sql:
          "SELECT groupListing.group_id FROM group_listings AS groupListing " +
          "WHERE groupListing.listing_id = ?",
      });
      expect(links.rows.map((r) => r.group_id)).toEqual([group.id]);
    });
  });

  describe("update", () => {
    test("answers not found when the row vanished before the update", async () => {
      const { id } = await createListing();
      const update = buildUpdateListingResource(
        (await getStoredListingWithCount(id))!,
        listingFormView("owner"),
      );
      await deleteListing(id);

      expect(
        await update.update(id, listingForm({ slug: "kept-slug" })),
      ).toEqual({
        notFound: true,
        ok: false,
      });
    });

    test("answers not found when the write loses the row", async () => {
      const created = await createListing();
      using _update = stub(listingRecord, "update", () =>
        Promise.resolve({ kind: "not-found" as const }),
      );

      expect(await saveListingEdit(created.id, {})).toEqual({
        notFound: true,
        ok: false,
      });
    });

    test("answers a record refusal with its message", async () => {
      const first = await createListing();
      const second = await createListing({ name: "Second listing" });

      expect(await saveListingEdit(second.id, { name: first.name })).toEqual({
        error: t("error.name_in_use"),
        ok: false,
      });
    });

    test("the slug is normalized and its lookup code recomputed", async () => {
      const created = await createListing();
      const row = await updateListing(created.id, { slug: "  New-Slug  " });
      expect(row.slug).toBe("new-slug");
      expect(row.slug_index).toBe(await hmacHash("new-slug"));
    });

    test("an empty-date save of a daily listing keeps its stored date", async () => {
      // The form's date box hides while the listing is daily, so the save
      // submits an empty date. The guard must see the STORED row: fed the
      // effective row, the date is already empty and the save would wipe it.
      const created = await createListing({
        date_date: "2026-06-15",
        date_time: "10:00",
        listing_type: "daily",
      });
      await updateListing(created.id, {});
      expect((await getStoredListingWithCount(created.id))!.date).toBe(
        "2026-06-15T10:00:00.000Z",
      );
    });

    test("clearing the price on an update stores a real zero", async () => {
      const created = await createListing({ unit_price: "12.34" });
      expect(created.unit_price).toBe(1234);

      const row = await updateListing(created.id, { unit_price: "0" });
      expect(row.unit_price).toBe(0);
      // A real stored zero, not an absent value: the column is what the base
      // price row is mirrored from.
      const stored = await getDb().execute({
        args: [row.id],
        sql:
          "SELECT listing.unit_price FROM listings AS listing " +
          "WHERE listing.id = ?",
      });
      expect(stored.rows[0]!.unit_price).toBe(0);
    });

    test("a daily listing keeps an emptied day selection empty", async () => {
      // A create with no days ticked opens every day by default...
      const created = await createListing({ listing_type: "daily" });
      expect(created.bookable_days).toEqual([...VALID_DAY_NAMES]);
      // ...but a daily update with none ticked means "no days", and stays so.
      const row = await updateListing(created.id, { listing_type: "daily" });
      expect(row.bookable_days).toEqual([]);
    });

    test("a standard listing's emptied day selection reopens every day", async () => {
      const created = await createListing({ bookable_days: ["Monday"] });
      const row = await updateListing(created.id, {});
      expect(row.bookable_days).toEqual([...VALID_DAY_NAMES]);
    });

    test("an unreadable day price rejects an update with a plain message", async () => {
      const created = await createListing({ duration_days: "2" });
      const result = await saveListingEdit(created.id, {
        day_price_1: "abc",
        duration_days: "2",
      });

      expect(result).toEqual({
        error: "Enter a valid day price for each duration, or leave it blank.",
        ok: false,
      });
      expect(await getListingDayPrices(created.id)).toEqual({});
    });

    test("refuses a max_quantity below a package membership quantity", async () => {
      const group = await createTestGroup({ name: "Cap package" });
      const created = await createListing({
        group_ids: [String(group.id)],
        max_quantity: "3",
      });
      // Three units per package stays legal while the cap sits at three.
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        description: "",
        is_package: "1",
        max_attendees: "0",
        name: group.name,
        slug: group.slug,
        terms_and_conditions: "",
        [`package_price_${created.id}`]: "9.00",
        [`package_qty_${created.id}`]: "3",
      });

      const result = await saveListingEdit(created.id, {
        group_ids: [String(group.id)],
        max_quantity: "2",
      });

      expect(result).toEqual({
        error: t("error.package_member_cap", {
          max_quantity: 2,
          name: "Parsed listing",
          quantity: 3,
        }),
        ok: false,
      });
      const [row] = await getGroupPackagePrices(group.id);
      expect(row?.quantity).toBe(3);
      const reread = await getListingWithCount(created.id);
      expect(reread!.max_quantity).toBe(3);
    });
  });
});
