import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  attributeOptionsOrder,
  attributesOrder,
  deleteAttribute,
  deleteAttributeOption,
  getAllAttributeOptionIds,
  getAllAttributesWithOptions,
  getAttributeWithOptions,
  getSelectedAttributesForListings,
  listingAttributeOptions,
  pruneInvalidAttributeOptionIds,
} from "#db/attributes.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

const names = <T extends { name: string }>(items: T[]): string[] =>
  items.map((item) => item.name);

const optionTexts = <T extends { text: string }>(items: T[]): string[] =>
  items.map((item) => item.text);

describeWithEnv("db > attributes", { db: true }, () => {
  test("lists attributes and options in their display order", async () => {
    const first = await createTestAttributeWithOptions("Difficulty", [
      "Beginner",
      "Advanced",
    ]);
    const second = await createTestAttributeWithOptions("Format", [
      "Online",
      "In person",
    ]);

    await attributesOrder.swap({ first: first.id, second: second.id });
    await attributeOptionsOrder.swap({
      first: first.options[0]!.id,
      scope: first.id,
      second: first.options[1]!.id,
    });

    const attributes = await getAllAttributesWithOptions();
    expect(names(attributes)).toEqual(["Format", "Difficulty"]);
    expect(optionTexts(attributes[1]!.options)).toEqual([
      "Advanced",
      "Beginner",
    ]);
  });

  test("loads one attribute with its options, or null for a missing attribute", async () => {
    const attribute = await createTestAttributeWithOptions("Access", [
      "Step-free",
    ]);

    const found = await getAttributeWithOptions(attribute.id);
    expect(found?.name).toBe("Access");
    expect(optionTexts(found?.options ?? [])).toEqual(["Step-free"]);
    expect(await getAttributeWithOptions(999_999)).toBeNull();
  });

  test("stores selected option ids for a listing and replaces them on save", async () => {
    const listing = await createTestListing({ name: "Mapped listing" });
    const attribute = await createTestAttributeWithOptions("Level", [
      "Gentle",
      "Intense",
    ]);

    await listingAttributeOptions.setIds(listing.id, [
      attribute.options[1]!.id,
      attribute.options[1]!.id,
      attribute.options[0]!.id,
    ]);
    expect(await listingAttributeOptions.getIds(listing.id)).toEqual([
      attribute.options[0]!.id,
      attribute.options[1]!.id,
    ]);

    await listingAttributeOptions.setIds(listing.id, [
      attribute.options[0]!.id,
    ]);
    expect(await listingAttributeOptions.getIds(listing.id)).toEqual([
      attribute.options[0]!.id,
    ]);
  });

  test("resolves selected attributes for many listings", async () => {
    const morning = await createTestListing({ name: "Morning" });
    const evening = await createTestListing({ name: "Evening" });
    const difficulty = await createTestAttributeWithOptions("Difficulty", [
      "Easy",
      "Hard",
    ]);
    const place = await createTestAttributeWithOptions("Place", [
      "Studio",
      "Online",
    ]);

    await listingAttributeOptions.setIds(morning.id, [
      difficulty.options[1]!.id,
      place.options[0]!.id,
    ]);
    await listingAttributeOptions.setIds(evening.id, [
      difficulty.options[0]!.id,
    ]);

    const byListing = await getSelectedAttributesForListings([
      morning.id,
      evening.id,
      morning.id,
    ]);
    expect(names(byListing.get(morning.id) ?? [])).toEqual([
      "Difficulty",
      "Place",
    ]);
    expect(optionTexts(byListing.get(morning.id)?.[0]?.options ?? [])).toEqual([
      "Hard",
    ]);
    expect(names(byListing.get(evening.id) ?? [])).toEqual(["Difficulty"]);
    expect(byListing.has(999_999)).toBe(false);
  });

  test("returns an empty map when no listing ids are requested", async () => {
    expect(await getSelectedAttributesForListings([])).toEqual(new Map());
  });

  test("deleting an option removes its listing assignments only", async () => {
    const listing = await createTestListing({ name: "Option delete listing" });
    const attribute = await createTestAttributeWithOptions("Season", [
      "Spring",
      "Autumn",
    ]);
    await listingAttributeOptions.setIds(
      listing.id,
      attribute.options.map((option) => option.id),
    );

    await deleteAttributeOption(attribute.options[0]!.id);

    expect(await listingAttributeOptions.getIds(listing.id)).toEqual([
      attribute.options[1]!.id,
    ]);
    const found = await getAttributeWithOptions(attribute.id);
    expect(optionTexts(found?.options ?? [])).toEqual(["Autumn"]);
  });

  test("deleting an attribute removes its options and listing assignments", async () => {
    const listing = await createTestListing({
      name: "Attribute delete listing",
    });
    const attribute = await createTestAttributeWithOptions("Audience", [
      "Adults",
      "Families",
    ]);
    await listingAttributeOptions.setIds(
      listing.id,
      attribute.options.map((option) => option.id),
    );

    await deleteAttribute(attribute.id);

    expect(await getAttributeWithOptions(attribute.id)).toBeNull();
    expect(await listingAttributeOptions.getIds(listing.id)).toEqual([]);
  });

  test("keeps only option ids that exist", async () => {
    const attribute = await createTestAttributeWithOptions("Food", [
      "Vegan",
      "Gluten-free",
    ]);
    const other = await createTestAttribute("Other");
    const otherOption = await createTestAttributeOption(other.id, "Other");

    expect(
      pruneInvalidAttributeOptionIds(await getAllAttributeOptionIds(), [
        attribute.options[1]!.id,
        123_456,
        otherOption.id,
        attribute.options[0]!.id,
      ]),
    ).toEqual([
      attribute.options[1]!.id,
      otherOption.id,
      attribute.options[0]!.id,
    ]);
  });
});
