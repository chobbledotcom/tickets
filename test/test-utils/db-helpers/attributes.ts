import {
  type AttributeOption,
  type AttributeWithOptions,
  attributesOrder,
  listingAttributeOptions,
} from "#db/attributes.ts";
import { records } from "#db/record-table.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { adminFormPost } from "#test-utils/session.ts";

export const createTestAttribute = async (
  name = "Test attribute",
): Promise<AttributeWithOptions> => {
  const attribute = await records.attributes.insert({ name });
  await attributesOrder.append({ key: attribute.id });
  return { ...attribute, options: [] };
};

export const createTestAttributeOption = (
  attributeId: number,
  text: string,
  sortOrder = 0,
): Promise<AttributeOption> =>
  records.attribute_options.insert({
    attribute_id: attributeId,
    sort_order: sortOrder,
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
  const { response } = await adminFormPost("/admin/attributes", { name });
  const location = expectRedirect(response, /^\/admin\/attributes\/\d+/);
  return Number(new URL(location, "http://localhost").pathname.split("/")[3]);
};
