import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type {
  AttributeOption,
  AttributeWithOptions,
  ListingAttributesById,
} from "#db/attributes.ts";
import {
  attributeFilterGroupsForListings,
  attributeFilterParam,
  filterListingsByAttributes,
  selectedAttributeFiltersFromRequest,
} from "#shared/listing-attribute-filter.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const option = (
  attributeId: number,
  id: number,
  text: string,
  sortOrder: number,
): AttributeOption => ({
  attribute_id: attributeId,
  id,
  sort_order: sortOrder,
  text,
});

const attribute = (
  id: number,
  name: string,
  sortOrder: number,
  options: AttributeOption[],
): AttributeWithOptions => ({
  id,
  name,
  options,
  sort_order: sortOrder,
});

const listingAttributes = (): ListingAttributesById => {
  const difficulty = attribute(1, "Difficulty", 2, [
    option(1, 12, "Hard", 2),
    option(1, 11, "Easy", 1),
  ]);
  const place = attribute(2, "Place", 1, [option(2, 21, "Studio", 1)]);
  return new Map([
    [101, [difficulty, place]],
    [102, [attribute(1, "Difficulty", 2, [option(1, 12, "Hard", 2)])]],
  ]);
};

describe("listing attribute filters", () => {
  test("uses a stable query parameter name per attribute", () => {
    expect(attributeFilterParam(42)).toBe("attribute_42");
  });

  test("builds filter groups from the listings currently being shown", () => {
    const filters = attributeFilterGroupsForListings(
      [102, 101],
      listingAttributes(),
    );

    expect(filters.map((filter) => filter.name)).toEqual([
      "Place",
      "Difficulty",
    ]);
    expect(filters[1]!.options.map((item) => item.text)).toEqual([
      "Easy",
      "Hard",
    ]);
  });

  test("uses ids to break attribute and option sort ties", () => {
    const filters = attributeFilterGroupsForListings(
      [101],
      new Map([
        [
          101,
          [
            attribute(2, "Second", 1, [
              option(2, 22, "Later", 1),
              option(2, 21, "Earlier", 1),
            ]),
            attribute(1, "First", 1, [
              option(1, 12, "Later", 1),
              option(1, 11, "Earlier", 1),
            ]),
          ],
        ],
      ]),
    );

    expect(filters.map((filter) => filter.id)).toEqual([1, 2]);
    expect(filters[0]!.options.map((item) => item.id)).toEqual([11, 12]);
  });

  test("reads only valid selected options from the request", () => {
    const filters = attributeFilterGroupsForListings(
      [101],
      listingAttributes(),
    );
    const request = new Request(
      "http://localhost/admin?attribute_1=11&attribute_2=999&attribute_3=21",
    );

    expect([...selectedAttributeFiltersFromRequest(request, filters)]).toEqual([
      [1, 11],
    ]);
  });

  test("ignores missing and non-numeric selected option values", () => {
    const filters = attributeFilterGroupsForListings(
      [101],
      listingAttributes(),
    );
    const request = new Request("http://localhost/admin?attribute_1=abc");

    expect(selectedAttributeFiltersFromRequest(request, filters).size).toBe(0);
  });

  test("keeps listings matching every selected attribute option", () => {
    const a = testListingWithCount({ id: 101, name: "A" });
    const b = testListingWithCount({ id: 102, name: "B" });
    const c = testListingWithCount({ id: 103, name: "C" });

    const result = filterListingsByAttributes(
      new Map([
        [1, 11],
        [2, 21],
      ]),
      listingAttributes(),
    )([a, b, c]);

    expect(result).toEqual([a]);
  });

  test("passes listings through when no attribute filters are selected", () => {
    const listings = [testListingWithCount({ id: 101 })];

    expect(
      filterListingsByAttributes(new Map(), listingAttributes())(listings),
    ).toBe(listings);
  });
});
