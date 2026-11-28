import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { parseProductFile } from "#cli/product-catalog/parse.ts";
import {
  checkedListingData,
  composeDescription,
  listingData,
} from "#cli/product-plan.ts";
import { listingApiBody } from "#shared/catalog-transfer/listing-api-body.ts";
import {
  formatTransferIssues,
  ListingDataSchema,
} from "#shared/catalog-transfer/schema.ts";

describe("product catalog listing data", () => {
  const productFrontmatter = `---
title: 8 Lane Reindeer Racing Hire
subtitle: Festive roll-and-bowl racing for up to 8 players
features:
  - Public liability insurance included
specs:
  - name: Players
    value: Up to 8 players
filter_attributes:
  - name: Guest Capacity
    value: 50-500+ guests
options:
  - name: 1 Day
    max_quantity: 10
    unit_price: 1695
    days: 1
  - name: 7 Days
    max_quantity: 10
    unit_price: 3995
    days: 7
---`;

  const sampleProduct = parseProductFile("a.md", productFrontmatter)!;
  const sampleBody = {
    attribute_option_ids: [11, 12],
    customisable_days: true,
    day_prices: { 1: 169500, 7: 399500 },
    description: composeDescription(sampleProduct),
    duration_days: 7,
    fields: "email,phone,address",
    group_ids: [5],
    hidden: true,
    listing_type: "daily",
    max_attendees: 10,
    max_quantity: 10,
    name: "8 Lane Reindeer Racing Hire",
  };

  test("builds the listing body from the rental options", () => {
    expect(
      listingApiBody(
        checkedListingData(sampleProduct.filename, listingData(sampleProduct)),
        { attributeOptionIds: [11, 12], groupIds: [5] },
      ),
    ).toEqual(sampleBody);
  });

  test("builds listing data that the admin schema accepts and the API body it maps to", () => {
    const parsed = v.safeParse(ListingDataSchema, listingData(sampleProduct));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      listingApiBody(parsed.output, {
        attributeOptionIds: [11, 12],
        groupIds: [5],
      }),
    ).toEqual(sampleBody);
  });

  test("caps the listing quantity at the strictest option", () => {
    const product = parseProductFile(
      "a.md",
      [
        "---",
        "title: Tumble Tower Hire",
        "options:",
        "  - name: 1 Day",
        "    max_quantity: 10",
        "    unit_price: 100",
        "  - name: 7 Days",
        "    days: 7",
        "    max_quantity: 2",
        "    unit_price: 500",
        "---",
      ].join("\n"),
    )!;
    // The site caps a daily listing's bookable quantity per date by
    // max_attendees, so the capacity follows the strictest option too.
    const body = listingApiBody(
      checkedListingData(product.filename, listingData(product)),
      { attributeOptionIds: null, groupIds: [] },
    );
    expect(body.max_quantity).toBe(2);
    expect(body.max_attendees).toBe(2);
  });

  test("refuses a product whose day price is above its duration", () => {
    const product = parseProductFile("a.md", productFrontmatter)!;
    // A product whose duration is shorter than one priced day would store a
    // price the admin importer refuses. The CLI must refuse it too.
    const data = { ...listingData(product), durationDays: 1 };
    expect(() => checkedListingData(product.filename, data)).toThrow(
      "dayPrices holds a price for a day the listing does not last",
    );
    const result = v.safeParse(ListingDataSchema, data);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatTransferIssues(result.issues)).toContain(
        "dayPrices holds a price for a day the listing does not last",
      );
    }
  });
});
