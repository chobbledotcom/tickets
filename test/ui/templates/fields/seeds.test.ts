import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { MAX_SEED_LISTINGS, seedsForm } from "#templates/fields/seeds.ts";

describe("seeds form", () => {
  test("offers the two number boxes between their bounds", () => {
    const [listings, attendees] = seedsForm.fields;
    expect(listings!.name).toBe("listing_count");
    expect(listings!.max).toBe(MAX_SEED_LISTINGS);
    expect(attendees!.name).toBe("attendees_per_listing");
    expect(attendees!.max).toBe(SEED_MAX_ATTENDEES);
  });

  test("starts each box at its suggested count", () => {
    expect(seedsForm.fields[0]!.defaultValue).toBe("5");
    expect(seedsForm.fields[1]!.defaultValue).toBe("10");
  });
});
