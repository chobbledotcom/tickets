import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import {
  answerLinesOf,
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
      const entry = makeEntry();
      const data = await buildTestData([entry], {
        answerLines: answerLinesOf([
          entry,
          [{ question: "Any allergies?", text: "None" }],
        ]),
      });

      expect(data.entries[0]!.attendee.answers).toEqual([
        { question: "Any allergies?", text: "None" },
      ]);
      expect(data.attendee.answers).toEqual(data.entries[0]!.attendee.answers);
    });

    test("lists each member's answers once on a collapsed hidden package's row", async () => {
      const diet = { question: "Diet?", text: "Vegan" };
      const first = makeEntry({}, { package_group_id: 5 });
      const member = makeEntry(
        { id: 2, name: "Member" },
        { package_group_id: 5 },
      );
      const data = await buildTestData([first, member], {
        answerLines: answerLinesOf(
          [first, [diet]],
          [member, [diet, { question: "Shoe size?", text: "9" }]],
        ),
        hidePackageMembers: true,
        packageDisplays: new Map([
          [5, { hideListings: true, name: "Hidden bundle" }],
        ]),
      });

      expect(data.entries).toHaveLength(1);
      expect(data.entries[0]!.listing.name).toBe("Hidden bundle");
      expect(data.entries[0]!.attendee.answers).toEqual([
        diet,
        { question: "Shoe size?", text: "9" },
      ]);
    });

    test("names the hidden package, not its member, on a collapsed row's answers", async () => {
      const member = makeEntry(
        { id: 2, name: "Secret Member" },
        { package_group_id: 5 },
      );
      const lines = [
        {
          concealedQuestion: "Pupil name (Hidden bundle, ticket 1)",
          question: "Pupil name (Secret Member in Hidden bundle, ticket 1)",
          text: "Ava",
        },
      ];
      const options = {
        answerLines: answerLinesOf([member, lines]),
        packageDisplays: new Map([
          [5, { hideListings: true, name: "Hidden bundle" }],
        ]),
      };

      const buyer = await buildTestData([member], {
        ...options,
        hidePackageMembers: true,
      });
      const admin = await buildTestData([member], options);

      expect(buyer.entries[0]!.attendee.answers).toEqual([
        { question: "Pupil name (Hidden bundle, ticket 1)", text: "Ava" },
      ]);
      expect(admin.entries[0]!.attendee.answers[0]?.question).toBe(
        "Pupil name (Secret Member in Hidden bundle, ticket 1)",
      );
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
      const data = await buildTestData([makeEntry({ unitPrice: 1000 })]);

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("marks can_pay_more listings as paid", async () => {
      const data = await buildTestData([
        makeEntry({ canPayMore: true, unitPrice: 0 }),
      ]);

      expect(data.entries[0]!.listing.is_paid).toBe(true);
    });

    test("marks a free-base entry as paid from its booking price", async () => {
      // A package override can charge a member whose base listing is free.
      const data = await buildTestData([
        makeEntry({ unitPrice: 0 }, { price_paid: "1" }),
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
      assertStringIncludes(
        await dateRangeLabelFor(
          { durationDays: 1, listingType: "daily" },
          { date: "2026-04-15" },
        ),
        "15 April",
      );
    });

    test("date_range_label: multi-day booking uses en dash", async () => {
      expect(
        await dateRangeLabelFor(
          { durationDays: 3, listingType: "daily" },
          { date: "2026-04-15", end_date: "2026-04-18" },
        ),
      ).toBe("15\u201317 April 2026");
    });

    test("date_range_label: empty when no booking date", async () => {
      expect(await dateRangeLabelFor({}, { date: null })).toBe("");
    });
  });
});
