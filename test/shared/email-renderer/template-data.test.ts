import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTemplateData } from "#shared/email-renderer.ts";
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

    test("builds correct data shape from multiple entries", async () => {
      const data = await buildTemplateData(
        [makeEntry({ name: "Listing A" }), makeEntry({ name: "Listing B" })],
        "GBP",
        "https://example.com/t/ABC+DEF",
      );

      expect(data.listing_names).toBe("Listing A and Listing B");
      expect(data.entries.length).toBe(2);
      expect(data.attendee.name).toBe("Jane Doe");
    });

    test("formats three or more listing names with commas and 'and'", async () => {
      const data = await buildTemplateData(
        [
          makeEntry({ name: "Listing A" }),
          makeEntry({ name: "Listing B" }),
          makeEntry({ name: "Listing C" }),
        ],
        "GBP",
        "https://example.com/t/ABC+DEF+GHI",
      );

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
