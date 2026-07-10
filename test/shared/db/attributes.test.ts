import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  deleteAttribute,
  deleteAttributeOption,
  getAllAttributesWithOptions,
  getAttributeWithOptions,
  getListingAttributeOptionIds,
  getSelectedAttributesForListings,
  pruneInvalidAttributeOptionIds,
  setListingAttributeOptions,
  swapAttributeOptionOrder,
  swapAttributeOrder,
} from "#shared/db/attributes.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
  createTestAttributeWithOptions,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

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

    await swapAttributeOrder(first.id, second.id);
    await swapAttributeOptionOrder(first.options[0]!.id, first.options[1]!.id);

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

    await setListingAttributeOptions(listing.id, [
      attribute.options[1]!.id,
      attribute.options[1]!.id,
      attribute.options[0]!.id,
    ]);
    expect(await getListingAttributeOptionIds(listing.id)).toEqual([
      attribute.options[0]!.id,
      attribute.options[1]!.id,
    ]);

    await setListingAttributeOptions(listing.id, [attribute.options[0]!.id]);
    expect(await getListingAttributeOptionIds(listing.id)).toEqual([
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

    await setListingAttributeOptions(morning.id, [
      difficulty.options[1]!.id,
      place.options[0]!.id,
    ]);
    await setListingAttributeOptions(evening.id, [difficulty.options[0]!.id]);

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
    await setListingAttributeOptions(
      listing.id,
      attribute.options.map((option) => option.id),
    );

    await deleteAttributeOption(attribute.options[0]!.id);

    expect(await getListingAttributeOptionIds(listing.id)).toEqual([
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
    await setListingAttributeOptions(
      listing.id,
      attribute.options.map((option) => option.id),
    );

    await deleteAttribute(attribute.id);

    expect(await getAttributeWithOptions(attribute.id)).toBeNull();
    expect(await getListingAttributeOptionIds(listing.id)).toEqual([]);
  });

  test("keeps only option ids that belong to known attributes", async () => {
    const attribute = await createTestAttributeWithOptions("Food", [
      "Vegan",
      "Gluten-free",
    ]);
    const hidden = await createTestAttribute("Hidden");
    await createTestAttributeOption(hidden.id, "Ignored");

    expect(
      pruneInvalidAttributeOptionIds(
        [attribute],
        [attribute.options[1]!.id, 123_456, attribute.options[0]!.id],
      ),
    ).toEqual([attribute.options[1]!.id, attribute.options[0]!.id]);
  });
});
