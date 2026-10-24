import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_SEED_LISTINGS, SEED_MAX_ATTENDEES } from "#shared/seeds.ts";
import { seedsForm } from "#templates/fields/seeds.ts";
import { inputNamed } from "#test-utils/html-fragments.ts";

describe("seeds form", () => {
  test("offers the two number boxes between their bounds", () => {
    const [listings, attendees] = seedsForm.fields;
    expect(listings!.name).toBe("listing_count");
    expect(listings!.max).toBe(MAX_SEED_LISTINGS);
    expect(attendees!.name).toBe("attendees_per_listing");
    expect(attendees!.max).toBe(SEED_MAX_ATTENDEES);
    // The limits themselves, pinned: the route clamps to the same numbers.
    expect(MAX_SEED_LISTINGS).toBe(30);
  });

  test("starts each box at its suggested count", () => {
    expect(seedsForm.fields[0]!.defaultValue).toBe("5");
    expect(seedsForm.fields[1]!.defaultValue).toBe("10");
  });

  test("renders both boxes required with their bounds and ids", () => {
    const [listings, attendees] = seedsForm.fields;
    expect(listings!.id).toBe("listing_count");
    expect(attendees!.id).toBe("attendees_per_listing");
    const html = seedsForm.render();
    const listingBox = inputNamed(html, "listing_count");
    assertStringIncludes(listingBox, 'min="1"');
    assertStringIncludes(listingBox, `max="${MAX_SEED_LISTINGS}"`);
    assertStringIncludes(listingBox, "required");
    const attendeeBox = inputNamed(html, "attendees_per_listing");
    assertStringIncludes(attendeeBox, 'min="0"');
    assertStringIncludes(attendeeBox, `max="${SEED_MAX_ATTENDEES}"`);
    assertStringIncludes(attendeeBox, "required");
  });
});
