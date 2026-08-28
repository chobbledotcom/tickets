import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { buildTestData, describeEmailRenderer } from "./test-helpers.ts";

describeEmailRenderer(() => {
  describe("package grouping", () => {
    const buildPackageEntries = async (hide: boolean) => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Camp Kit",
      });
      if (hide) {
        await groups.table.update(group.id, { hidePackageListings: true });
      }
      const tent = await createTestListing({
        groupId: group.id,
        name: "Tent",
        unitPrice: 0,
      });
      const chair = await createTestListing({
        groupId: group.id,
        name: "Chair",
        unitPrice: 500,
      });
      return [
        makeEntry(
          { id: tent.id, name: "Tent", unit_price: 0 },
          { package_group_id: group.id, price_paid: "2000", quantity: 2 },
        ),
        makeEntry(
          { id: chair.id, name: "Chair", unit_price: 500 },
          { package_group_id: group.id, price_paid: "3000", quantity: 6 },
        ),
      ];
    };

    test("a non-hidden package heads the email with its name and lists members", async () => {
      const data = await buildTestData(await buildPackageEntries(false));

      expect(data.listing_names).toBe("Camp Kit");
      expect(data.entries.map((entry) => entry.listing.name)).toEqual([
        "Tent",
        "Chair",
      ]);
    });

    test("a hidden package collapses to one row for the buyer's confirmation", async () => {
      const data = await buildTestData(await buildPackageEntries(true), {
        hidePackageMembers: true,
      });

      expect(data.listing_names).toBe("Camp Kit");
      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.listing.name).toBe("Camp Kit");
      expect(data.entries[0]!.attendee.quantity).toBe(8);
      expect(data.entries[0]!.attendee.price_paid).toBe("5000");
      expect(data.entries[0]!.listing.is_paid).toBe(true);
      expect(data.entries[0]!.attendee.date_range_label).toBe("");
      expect(data.entries[0]!.listing.slug).toBe("");
    });

    test("a collapsed hidden package of free-base members is paid from prices", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Free Kit",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const memberA = await createTestListing({
        groupId: group.id,
        name: "A",
        unitPrice: 0,
      });
      const memberB = await createTestListing({
        groupId: group.id,
        name: "B",
        unitPrice: 0,
      });
      const data = await buildTestData(
        [
          makeEntry(
            { id: memberA.id, name: "A", unit_price: 0 },
            { package_group_id: group.id, price_paid: "1000", quantity: 1 },
          ),
          makeEntry(
            { id: memberB.id, name: "B", unit_price: 0 },
            { package_group_id: group.id, price_paid: "0", quantity: 1 },
          ),
        ],
        { hidePackageMembers: true },
      );

      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("a dated hidden package collapses keeping the widest member's range", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Dated Kit",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const spans: [name: string, endDate: string | null][] = [
        ["Day Only", null],
        ["Narrow A", "2026-08-02"],
        ["Wide", "2026-08-04"],
        ["Narrow B", "2026-08-02"],
      ];
      const entries = [];
      for (const [name, endDate] of spans) {
        const listing = await createTestListing({
          groupId: group.id,
          name,
          unitPrice: 500,
        });
        entries.push(
          makeEntry(
            { id: listing.id, name, unit_price: 500 },
            {
              date: "2026-08-01",
              end_date: endDate,
              package_group_id: group.id,
              price_paid: "500",
              quantity: 1,
            },
          ),
        );
      }
      const data = await buildTestData(entries, { hidePackageMembers: true });

      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.attendee.date).toBe("2026-08-01");
      expect(data.entries[0]!.attendee.date_range_label).toBe(
        "1–3 August 2026",
      );
    });

    test("a hidden package still shows members in the admin notification", async () => {
      const data = await buildTestData(await buildPackageEntries(true));

      expect(data.entries.map((entry) => entry.listing.name)).toEqual([
        "Tent",
        "Chair",
      ]);
    });

    test("a mixed order conceals its hidden bundle beside plain rows", async () => {
      const entries = await buildPackageEntries(true);
      const lantern = await createTestListing({
        name: "Lantern",
        unitPrice: 300,
      });
      entries.push(
        makeEntry(
          { id: lantern.id, name: "Lantern", unit_price: 300 },
          { price_paid: "300", quantity: 1 },
        ),
      );
      const data = await buildTestData(entries, { hidePackageMembers: true });

      expect(data.listing_names).toBe("Camp Kit and Lantern");
      expect(data.entries.map((entry) => entry.listing.name)).toEqual([
        "Camp Kit",
        "Lantern",
      ]);
      expect(data.entries[0]!.attendee.quantity).toBe(8);
      expect(data.entries[1]!.attendee.quantity).toBe(1);
    });

    test("one row of a hidden bundle still collapses behind the bundle's name", async () => {
      // Booking one thing out of a hidden bundle is still a bundle booking, so
      // the row it collapses to carries the bundle's name and the buyer's own
      // contact — the whole point of hiding the members.
      const group = await createTestGroup({
        isPackage: true,
        name: "Single Kit",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const only = await createTestListing({
        groupId: group.id,
        name: "Only Member",
        unitPrice: 500,
      });
      const entry = makeEntry(
        { id: only.id, name: "Only Member", unit_price: 500 },
        { package_group_id: group.id, price_paid: "1500", quantity: 3 },
      );

      const data = await buildTestData([entry], { hidePackageMembers: true });

      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.listing.name).toBe("Single Kit");
      expect(data.entries[0]!.attendee.quantity).toBe(3);
      expect(data.entries[0]!.attendee.price_paid).toBe("1500");
      // The buyer's own contact comes from the row that was booked, so a
      // collapse that reached past it for a second row it does not have would
      // fail here rather than send an email addressed to nobody.
      expect(data.entries[0]!.attendee.name).toBe(entry.attendee.name);
      expect(data.entries[0]!.attendee.email).toBe(entry.attendee.email);
    });

    test("a standalone booking of a hidden one-member package's listing is NOT collapsed", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Solo Kit",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      const widget = await createTestListing({
        groupId: group.id,
        name: "Widget",
        unitPrice: 500,
      });
      const data = await buildTestData(
        [
          makeEntry(
            { id: widget.id, name: "Widget", unit_price: 500 },
            { price_paid: "1500", quantity: 3 },
          ),
        ],
        { hidePackageMembers: true },
      );

      expect(data.listing_names).toBe("Widget");
      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.listing.name).toBe("Widget");
    });
  });
});
