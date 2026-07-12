import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeListingRows,
  optionListingCounts,
} from "#routes/admin/attribute-page-data.ts";
import type { AttributeOption } from "#shared/db/attributes.ts";
import type { ListingOption } from "#shared/db/listings/records.ts";

const option = (id: number, text: string): AttributeOption => ({
  attribute_id: 1,
  id,
  sort_order: id,
  text,
});

const listing = (id: number, name: string, active = true): ListingOption => ({
  active,
  id,
  name,
});

describe("attributeListingRows", () => {
  const easy = option(10, "Easy");
  const hard = option(11, "Hard");
  const listings = [
    listing(1, "Climbing"),
    listing(2, "Walking", false),
    listing(3, "Untagged"),
  ];

  test("keeps only listings that selected an option, in listing order", () => {
    const rows = attributeListingRows(
      [easy, hard],
      new Map([
        [easy.id, [2, 1]],
        [hard.id, [2]],
      ]),
      listings,
    );

    expect(rows).toEqual([
      { active: true, id: 1, name: "Climbing", optionTexts: ["Easy"] },
      { active: false, id: 2, name: "Walking", optionTexts: ["Easy", "Hard"] },
    ]);
  });

  test("scoped to a single option, only that option's listings remain", () => {
    const rows = attributeListingRows(
      [hard],
      new Map([
        [easy.id, [1]],
        [hard.id, [2]],
      ]),
      listings,
    );

    expect(rows).toEqual([
      { active: false, id: 2, name: "Walking", optionTexts: ["Hard"] },
    ]);
  });

  test("returns no rows when no listing selected any option", () => {
    expect(attributeListingRows([easy], new Map(), listings)).toEqual([]);
  });
});

describe("optionListingCounts", () => {
  test("counts the listings behind each option id", () => {
    const counts = optionListingCounts(
      new Map([
        [10, [1, 2, 3]],
        [11, [7]],
      ]),
    );

    expect(counts).toEqual(
      new Map([
        [10, 3],
        [11, 1],
      ]),
    );
  });
});
