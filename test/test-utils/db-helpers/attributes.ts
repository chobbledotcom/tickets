import {
  type AttributeOption,
  type AttributeWithOptions,
  assignNextAttributeSortOrder,
  attributeOptionsTable,
  attributesTable,
  listingAttributeOptions,
} from "#shared/db/attributes.ts";

export const createTestAttribute = async (
  name = "Test attribute",
): Promise<AttributeWithOptions> => {
  const attribute = await attributesTable.insert({ name });
  await assignNextAttributeSortOrder(attribute.id);
  return { ...attribute, options: [] };
};

export const createTestAttributeOption = (
  attributeId: number,
  text: string,
  sortOrder = 0,
): Promise<AttributeOption> =>
  attributeOptionsTable.insert({
    attributeId,
    sortOrder,
    text,
  });

export const createTestAttributeWithOptions = async (
  name: string,
  optionTexts: string[],
): Promise<AttributeWithOptions> => {
  const attribute = await createTestAttribute(name);
  const options = await Promise.all(
    optionTexts.map((text, sortOrder) =>
      createTestAttributeOption(attribute.id, text, sortOrder),
    ),
  );
  return { ...attribute, options };
};

export const assignTestAttributeOptions = (
  listingId: number,
  options: AttributeOption[],
): Promise<void> =>
  listingAttributeOptions.setIds(
    listingId,
    options.map((option) => option.id),
  );
