import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import { listingAttributeOptions } from "#db/attributes.ts";
import { getDb } from "#db/client.ts";
import { getGroupPackagePrices } from "#db/groups.ts";
import { getImagesForItem } from "#db/images.ts";
import { getListingDayPrices } from "#db/listing-prices.ts";
import { deleteListing } from "#db/listings/delete.ts";
import {
  getListingWithCount,
  getStoredListingWithCount,
} from "#db/listings/records.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { t } from "#i18n";
import {
  buildCreateListingResource,
  buildUpdateListingResource,
  checkedDurationDays,
} from "#routes/admin/listings-form.ts";
import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import { listingRecord } from "#shared/records/listings.ts";
import { listingFormView } from "#templates/fields/listing.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  bookableStartDates,
  createTestListing,
  dailySwitchForm,
  listingWithOneBooking,
} from "#test-utils/db-helpers/listings.ts";
import { testFormParams } from "#test-utils/form-values.ts";
import { testEachRefusal } from "#test-utils/refusal-table.ts";
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
        expect(row.listingType).toBe("standard");
        expect(row.unitPrice).toBe(0);
        expect(row.maxAttendees).toBe(50);
        expect(row.maxQuantity).toBe(5);
        expect(row.bookableDays).toEqual([...VALID_DAY_NAMES]);
        expect(row.closesAt).toBeNull();
      })());

    test("refuses a quantity below the field's declared minimum", async () => {
      for (const [field, value] of [
        ["maxAttendees", "0"],
        ["minQuantity", "0"],
      ] as const) {
        const result = await tryCreateListing({ [field]: value });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBe(
            field === "maxAttendees"
              ? "Max items must be 1 or greater"
              : "Min items per purchase must be 1 or greater",
          );
        }
      }
    });

    test("accepts quantities at the declared minimum", async () => {
      const row = await createListing({
        maxAttendees: "1",
        maxQuantity: "1",
        minQuantity: "1",
      });
      expect(row.maxAttendees).toBe(1);
      expect(row.maxQuantity).toBe(1);
      expect(row.minQuantity).toBe(1);
    });

    test("a zero unit price stays an explicit zero", async () => {
      const row = await createListing({ unitPrice: "0" });
      expect(row.unitPrice).toBe(0);
    });

    test("a priced form stores the currency's minor units", async () => {
      const row = await createListing({
        maxPrice: "12.5",
        unitPrice: "12.34",
      });
      expect(row.unitPrice).toBe(1234);
      expect(row.maxPrice).toBe(1250);
    });

    test("datetimes normalize to UTC, and blanks stay blank", async () => {
      const dated = await createListing({
        closesAtDate: "2026-06-15",
        closesAtTime: "14:30",
        dateDate: "2026-03-01",
        dateTime: "09:05",
      });
      expect(dated.closesAt).toBe("2026-06-15T14:30:00.000Z");
      expect(dated.date).toBe("2026-03-01T09:05:00.000Z");

      const blank = await createListing({ name: "Undated" });
      expect(blank.closesAt).toBeNull();
      expect(blank.date).toBe("");
    });

    test("chosen bookable days are kept as chosen, even a single one", async () => {
      for (const days of [["Monday", "Thursday"], ["Friday"]]) {
        expect(
          (await createListing({ bookableDays: days, name: days.join(" ") }))
            .bookableDays,
        ).toEqual(days);
      }
    });

    test("a listing with no closing date stores nothing in that column", async () => {
      const row = await createListing();
      const stored = await getDb().execute(
        sql`SELECT listing.closes_at FROM listings AS listing WHERE listing.id = ${row.id}`,
      );
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
        duplicatedFrom: String(source.id),
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
        duplicatedFrom: String(source.id),
        groupIds: String(group.id),
        maxQuantity: "2",
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
        dayPrice1: "10",
        dayPrice2: "",
        dayPrice3: "30",
        dayPrice4: "40",
        durationDays: "3",
      });
      expect(await getListingDayPrices(row.id)).toEqual({ 1: 1000, 3: 3000 });
    });

    test("without a duration, only the single-day price is read", async () => {
      const row = await createListing({
        dayPrice1: "15",
        dayPrice2: "20",
      });
      expect(await getListingDayPrices(row.id)).toEqual({ 1: 1500 });
    });

    testEachRefusal(tryCreateListing, [
      [
        "an impossible date is refused before anything is saved",
        { dateDate: "2026-02-30", dateTime: "10:00" },
        "Please enter a valid date and time",
      ],
      [
        "an unreadable day price rejects the save with a plain message",
        { dayPrice1: "abc", durationDays: "2" },
        "Enter a valid day price for each duration, or leave it blank.",
      ],
    ]);

    test("ticked groups are saved", async () => {
      const group = await createTestGroup({ name: "Form group" });
      const row = await createListing({
        groupIds: [String(group.id)],
      });
      const links = await getDb().execute(
        sql`SELECT groupListing.group_id FROM group_listings AS groupListing WHERE groupListing.listing_id = ${row.id}`,
      );
      expect(links.rows.map((r) => r.group_id)).toEqual([group.id]);
    });

    test("a group box that is not a group id is refused, not dropped", async () => {
      const group = await createTestGroup({ name: "Form group" });
      const result = await tryCreateListing({
        groupIds: [String(group.id), "0", "-4"],
      });
      expect(result).toEqual({
        error: "Choose Groups from the list. Reload the page and choose again.",
        ok: false,
      });
    });

    test("the use-defaults tick is refused until the site holds defaults", async () => {
      expect(await tryCreateListing({ useDefaults: "1" })).toEqual({
        error: t("fields.validation.unshown_field"),
        ok: false,
      });
      await settings.update.listingDefaults({ hidden: true });
      const ticked = await createListing({ useDefaults: "1" });
      const plain = await createListing({ name: "Own values" });
      expect([ticked.useDefaults, plain.useDefaults]).toEqual([true, false]);
    });

    test("the checked duration is the form's count, never a blank", () => {
      expect(checkedDurationDays({ durationDays: 3 })).toBe(3);
      expect(() => checkedDurationDays({ durationDays: null })).toThrow(
        "The booking duration form box holds no count",
      );
    });

    test("one picture chosen on the form links to the new listing", async () => {
      const image = await makeImage("Chosen");
      const form = listingForm();
      const view = listingFormView("owner");
      const result = await buildCreateListingResource(form, view, [
        image.id,
      ]).create(form);
      if (!result.ok) throw new Error(result.error);
      const linked = await getImagesForItem("listing", result.row.id);
      expect(linked.map((one) => one.id)).toEqual([image.id]);
    });

    test("answers a missing row when the write loses the new listing", async () => {
      using _create = stub(listingRecord, "create", () =>
        Promise.resolve({ kind: "not-found" as const }),
      );
      expect(await tryCreateListing()).toEqual({
        error: "Listing not found",
        ok: false,
      });
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
      expect(row.slugIndex).toBe(await hmacHash("new-slug"));
    });

    test("a refused update fails with the refusal it got", async () => {
      const { id } = await createListing();
      const refused = updateListing(id, { name: "" });
      await expect(refused).rejects.toThrow('update failed: {"error":');
    });

    test("an empty-date save of a daily listing keeps its stored date", async () => {
      // The form's date box hides while the listing is daily, so the save
      // submits an empty date. The guard must see the STORED row: fed the
      // effective row, the date is already empty and the save would wipe it.
      const created = await createListing({
        dateDate: "2026-06-15",
        dateTime: "10:00",
        listingType: "daily",
      });
      await updateListing(created.id, {});
      expect((await getStoredListingWithCount(created.id))!.date).toBe(
        "2026-06-15T10:00:00.000Z",
      );
    });

    test("clearing the price on an update stores a real zero", async () => {
      const created = await createListing({ unitPrice: "12.34" });
      expect(created.unitPrice).toBe(1234);

      const row = await updateListing(created.id, { unitPrice: "0" });
      expect(row.unitPrice).toBe(0);
      // A real stored zero, not an absent value: the column is what the base
      // price row is mirrored from.
      const stored = await getDb().execute(
        sql`SELECT listing.unit_price FROM listings AS listing WHERE listing.id = ${row.id}`,
      );
      expect(stored.rows[0]!.unit_price).toBe(0);
    });

    test("a daily listing keeps an emptied day selection empty", async () => {
      // A create with no days ticked opens every day by default...
      const created = await createListing({ listingType: "daily" });
      expect(created.bookableDays).toEqual([...VALID_DAY_NAMES]);
      // ...but a daily update with none ticked means "no days", and stays so.
      const row = await updateListing(created.id, { listingType: "daily" });
      expect(row.bookableDays).toEqual([]);
    });

    test("a standard listing's emptied day selection reopens every day", async () => {
      const created = await createListing({ bookableDays: ["Monday"] });
      const row = await updateListing(created.id, {});
      expect(row.bookableDays).toEqual([...VALID_DAY_NAMES]);
    });

    test("an unreadable day price rejects an update with a plain message", async () => {
      const created = await createListing({ durationDays: "2" });
      const result = await saveListingEdit(created.id, {
        dayPrice1: "abc",
        durationDays: "2",
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
        groupIds: [String(group.id)],
        maxQuantity: "3",
      });
      // Three units per package stays legal while the cap sits at three.
      await adminFormPost(`/admin/groups/${group.id}/edit`, {
        description: "",
        isPackage: "1",
        maxAttendees: "0",
        name: group.name,
        slug: group.slug,
        termsAndConditions: "",
        [`packagePrice${created.id}`]: "9.00",
        [`packageQty${created.id}`]: "3",
      });

      const result = await saveListingEdit(created.id, {
        groupIds: [String(group.id)],
        maxQuantity: "2",
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
      expect(reread!.maxQuantity).toBe(3);
    });

    describe("a switch to daily over an undated booking", () => {
      /** Save the switch form, with or without the confirmed move. */
      const saveSwitch = async (confirmed: boolean, groupIds: string[]) => {
        const stored = await listingWithOneBooking(
          { maxAttendees: 2, name: "Hall" },
          { quantity: 1 },
        );
        const [date] = await bookableStartDates(stored.id);
        const assign = confirmed ? { count: 1, date: date! } : undefined;
        const form = testFormParams(dailySwitchForm(stored, { groupIds }));
        const view = listingFormView("owner");
        return {
          date: date!,
          id: stored.id,
          result: await buildUpdateListingResource(stored, view, assign).update(
            stored.id,
            form,
          ),
        };
      };

      test("a bare switch is refused with the guard's message", async () => {
        const { result } = await saveSwitch(false, []);

        expect(result).toEqual({
          error: t("listings_table.switch_daily_undated_guard", { count: 1 }),
          ok: false,
        });
      });

      test("a confirmed switch dates the booking and writes the groups", async () => {
        const group = await createTestGroup({ name: "Switch group" });
        const { date, id, result } = await saveSwitch(true, [
          String(group.id),
        ]);

        expect(result).toMatchObject({
          ok: true,
          row: { listingType: "daily" },
        });
        const links = await getDb().execute(
          sql`SELECT groupListing.group_id FROM group_listings AS groupListing WHERE groupListing.listing_id = ${id}`,
        );
        expect(links.rows.map((r) => r.group_id)).toEqual([group.id]);
        const booked = await getDb().execute(
          sql`SELECT listingAttendee.start_at FROM listing_attendees AS listingAttendee WHERE listingAttendee.listing_id = ${id}`,
        );
        expect(String(booked.rows[0]!.start_at)).toContain(date);
      });
    });
  });
});
