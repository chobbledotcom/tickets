import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import {
  buildTestData,
  describeEmailRenderer,
  TICKET_URL,
} from "./test-helpers.ts";

describeEmailRenderer(() => {
  describe("buildTemplateData", () => {
    test("builds correct data shape from single entry", async () => {
      const data = await buildTestData([makeEntry()]);

      expect(data.listing_names).toBe("Test Listing");
      expect(data.ticket_url).toBe(TICKET_URL);
      expect(data.currency).toBe("GBP");
      expect(data.entries.length).toBe(1);
      expect(data.entries[0]!.listing.name).toBe("Test Listing");
      expect(data.entries[0]!.listing.slug).toBe("test-listing");
      expect(data.entries[0]!.listing.is_paid).toBe(false);
      expect(data.attendee.name).toBe("Jane Doe");
      expect(data.attendee.email).toBe("jane@example.com");
    });

    test("carries each entry's answer lines into the attendee shape", async () => {
      const data = await buildTestData([makeEntry()], {
        answerLines: new Map([
          [42, new Map([[1, [{ question: "Any allergies?", text: "None" }]]])],
        ]),
      });

      expect(data.entries[0]!.attendee.answers).toEqual([
        { question: "Any allergies?", text: "None" },
      ]);
      expect(data.attendee.answers).toEqual(data.entries[0]!.attendee.answers);
    });

    test("lists each member's answers once on a collapsed hidden package's row", async () => {
      const diet = { question: "Diet?", text: "Vegan" };
      const data = await buildTestData(
        [
          makeEntry({}, { package_group_id: 5 }),
          makeEntry({ id: 2, name: "Member" }, { package_group_id: 5 }),
        ],
        {
          answerLines: new Map([
            [
              42,
              new Map([
                [1, [diet]],
                [2, [diet, { question: "Shoe size?", text: "9" }]],
              ]),
            ],
          ]),
          hidePackageMembers: true,
          packageDisplays: new Map([
            [5, { hideListings: true, name: "Hidden bundle" }],
          ]),
        },
      );

      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]!.listing.name).toBe("Hidden bundle");
      expect(data.entries[0]!.attendee.quantity).toBe(2);
      expect(data.entries[0]!.attendee.quantity_label).toBe("2 tickets");
      expect(data.entries[0]!.attendee.answers).toEqual([
        diet,
        { question: "Shoe size?", text: "9" },
      ]);
    });

    test("builds correct data shape from multiple entries", async () => {
      const data = await buildTestData([
        makeEntry({ name: "Listing A" }),
        makeEntry({ name: "Listing B" }),
      ]);

      expect(data.listing_names).toBe("Listing A and Listing B");
      expect(data.entries.length).toBe(2);
      expect(data.attendee.name).toBe("Jane Doe");
    });

    test("formats three or more listing names with commas and 'and'", async () => {
      const data = await buildTestData([
        makeEntry({ name: "Listing A" }),
        makeEntry({ name: "Listing B" }),
        makeEntry({ name: "Listing C" }),
      ]);

      expect(data.listing_names).toBe("Listing A, Listing B, and Listing C");
    });

    test("marks paid listings correctly", async () => {
      const data = await buildTestData([makeEntry({ unit_price: 1000 })]);

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("marks can_pay_more listings as paid", async () => {
      const data = await buildTestData([
        makeEntry({ can_pay_more: true, unit_price: 0 }),
      ]);

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("marks a free-base entry as paid from its booking price", async () => {
      // A package override can charge a member whose base listing is free.
      const data = await buildTestData([
        makeEntry({ unit_price: 0 }, { price_paid: "1" }),
      ]);

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("includes attendee date when present", async () => {
      const data = await buildTestData([makeEntry({}, { date: "2026-04-15" })]);

      expect(data.entries[0]!.attendee.date).toBe("2026-04-15");
    });

    test("words a standard row's quantity as tickets", async () => {
      const data = await buildTestData([makeEntry({}, { quantity: 2 })]);

      expect(data.entries[0]!.attendee.quantity_label).toBe("2 tickets");
    });

    test("words one ticket in the singular", async () => {
      const data = await buildTestData([makeEntry({}, { quantity: 1 })]);

      expect(data.entries[0]!.attendee.quantity_label).toBe("1 ticket");
    });

    test("words a site plan row's quantity as its months", async () => {
      const data = await buildTestData([
        makeEntry(
          { assign_built_site: true, initial_site_months: 3 },
          { quantity: 3 },
        ),
      ]);

      expect(data.entries[0]!.attendee.quantity_label).toBe("9 months");
    });

    test("words one plan month in the singular", async () => {
      const data = await buildTestData([
        makeEntry(
          { assign_built_site: true, initial_site_months: 1 },
          { quantity: 1 },
        ),
      ]);

      expect(data.entries[0]!.attendee.quantity_label).toBe("1 month");
    });

    const dateRangeLabelFor = async (
      listing: Partial<Parameters<typeof makeEntry>[0]>,
      attendee: Partial<Parameters<typeof makeEntry>[1]>,
    ): Promise<string> =>
      (await buildTestData([makeEntry(listing, attendee)])).entries[0]!.attendee
        .date_range_label;

    test("date_range_label: single-day daily booking formats as a date", async () => {
      expect(
        await dateRangeLabelFor(
          { duration_days: 1, listing_type: "daily" },
          { date: "2026-04-15" },
        ),
      ).toContain("15 April");
    });

    test("date_range_label: multi-day booking uses en dash", async () => {
      expect(
        await dateRangeLabelFor(
          { duration_days: 3, listing_type: "daily" },
          { date: "2026-04-15", end_date: "2026-04-18" },
        ),
      ).toBe("15\u201317 April 2026");
    });

    test("date_range_label: empty when no booking date", async () => {
      expect(await dateRangeLabelFor({}, { date: null })).toBe("");
    });
  });
});
