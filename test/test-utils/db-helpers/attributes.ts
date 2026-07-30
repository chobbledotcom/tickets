import {
  type AttributeOption,
  type AttributeWithOptions,
  attributeOptionsTable,
  attributesOrder,
  attributesTable,
  listingAttributeOptions,
} from "#shared/db/attributes.ts";

export const createTestAttribute = async (
  name = "Test attribute",
): Promise<AttributeWithOptions> => {
  const attribute = await attributesTable.insert({ name });
  await attributesOrder.append({ key: attribute.id });
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

/** Create an attribute through the real admin POST and return its new id. */
export const createAttributeViaRoute = async (
  name: string,
): Promise<number> => {
  const { adminFormPost } = await import("#test-utils/session.ts");
  const { expectRedirect } = await import("#test-utils/assertions.ts");
  const { response } = await adminFormPost("/admin/attributes", { name });
  const location = expectRedirect(response, /^\/admin\/attributes\/\d+/);
  return Number(new URL(location, "http://localhost").pathname.split("/")[3]);
};
