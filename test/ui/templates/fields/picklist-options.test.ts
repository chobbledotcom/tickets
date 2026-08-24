import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { picklistOptions } from "#templates/fields/picklist-options.ts";
import { ListingTypeSchema } from "#types";

describe("picklistOptions", () => {
  test("maps a schema's options to value + i18n label, in schema order", () => {
    // Uses a real schema and a real key prefix so a wrong key template or a
    // dropped/duplicated option would change the result.
    expect(picklistOptions(ListingTypeSchema, "fields.listing.type")).toEqual([
      { label: "Standard", value: "standard" },
      { label: "Daily", value: "daily" },
    ]);
  });

  test("covers every declared member exactly once", () => {
    const options = picklistOptions(ListingTypeSchema, "fields.listing.type");
    expect(options.map((o) => o.value)).toEqual([...ListingTypeSchema.options]);
  });
});
