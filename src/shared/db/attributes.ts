/**
 * Listing attributes: reusable multiple-choice metadata shown on listing pages.
 *
 * Attributes do not participate in booking. A listing stores selected option
 * ids only; display code resolves those ids back to ordered attribute groups.
 */

import { map, reduce, unique } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  executeBatch,
  inPlaceholders,
  queryAll,
  queryOne,
} from "#shared/db/client.ts";
import { linkTableSide } from "#shared/db/link-table.ts";
import { swapSortOrder } from "#shared/db/query.ts";
import { col, defineTable } from "#shared/db/table.ts";

export type Attribute = {
  id: number;
  name: string;
  sort_order: number;
};

export type AttributeOption = {
  attribute_id: number;
  id: number;
  sort_order: number;
  text: string;
};

export type AttributeWithOptions = Attribute & {
  options: AttributeOption[];
};

export type ListingAttributesById = Map<number, AttributeWithOptions[]>;

type AttributeInput = {
  name: string;
  sortOrder?: number;
};

type AttributeOptionInput = {
  attributeId: number;
  sortOrder: number;
  text: string;
};

const generatedId = col.generated<number>();
const encryptedText = col.encrypted(encrypt, decrypt);

export const attributesTable = defineTable<Attribute, AttributeInput>({
  name: "attributes",
  primaryKey: "id",
  schema: {
    id: generatedId,
    name: encryptedText,
    sort_order: col.withDefault(() => 0),
  },
});

export const attributeOptionsTable = defineTable<
  AttributeOption,
  AttributeOptionInput
>({
  name: "attribute_options",
  primaryKey: "id",
  schema: {
    attribute_id: col.simple<number>(),
    id: generatedId,
    sort_order: col.withDefault(() => 0),
    text: encryptedText,
  },
});

export const listingAttributeOptions = linkTableSide(
  "listing_attribute_options",
  "listing_id",
  "option_id",
);

const ATTRIBUTE_COLS = `attribute.id AS attribute_id,
       attribute.name AS attribute_name,
       attribute.sort_order AS attribute_sort_order,
       attributeOption.id AS option_id,
       attributeOption.attribute_id AS option_attribute_id,
       attributeOption.text AS option_text,
       attributeOption.sort_order AS option_sort_order`;

type JoinedAttributeRow = {
  attribute_id: number;
  attribute_name: string;
  attribute_sort_order: number;
  option_attribute_id: number | null;
  option_id: number | null;
  option_sort_order: number | null;
  option_text: string | null;
};

type SelectedAttributeRow = JoinedAttributeRow & {
  listing_id: number;
};

type AttributeGroup = {
  name: string;
  sortOrder: number;
  options: AttributeOption[];
};

const rowOption = (row: JoinedAttributeRow): AttributeOption | null =>
  row.option_id === null
    ? null
    : {
        attribute_id: row.option_attribute_id!,
        id: row.option_id,
        sort_order: row.option_sort_order!,
        text: row.option_text!,
      };

const collectAttributeRow = (
  acc: Map<number, AttributeGroup>,
  row: JoinedAttributeRow,
): Map<number, AttributeGroup> => {
  const group = acc.get(row.attribute_id) ?? {
    name: row.attribute_name,
    options: [],
    sortOrder: row.attribute_sort_order,
  };
  const option = rowOption(row);
  if (option) group.options.push(option);
  return acc.set(row.attribute_id, group);
};

const decryptAttribute = async (
  id: number,
  group: AttributeGroup,
): Promise<AttributeWithOptions> => {
  const [attribute, ...options] = await Promise.all([
    attributesTable.fromDb({
      id,
      name: group.name,
      sort_order: group.sortOrder,
    }),
    ...group.options.map((option) => attributeOptionsTable.fromDb(option)),
  ]);
  return { ...attribute, options };
};

const groupAttributeRows = async (
  rows: JoinedAttributeRow[],
): Promise<AttributeWithOptions[]> =>
  Promise.all(
    [
      ...reduce(collectAttributeRow, new Map<number, AttributeGroup>())(rows),
    ].map(([id, group]) => decryptAttribute(id, group)),
  );

export const getAllAttributesWithOptions = async (): Promise<
  AttributeWithOptions[]
> =>
  groupAttributeRows(
    await queryAll<JoinedAttributeRow>(
      `SELECT ${ATTRIBUTE_COLS}
         FROM attributes AS attribute
         LEFT JOIN attribute_options AS attributeOption
           ON attributeOption.attribute_id = attribute.id
        ORDER BY attribute.sort_order, attribute.id,
                 attributeOption.sort_order, attributeOption.id`,
    ),
  );

export const getAttributeWithOptions = async (
  id: number,
): Promise<AttributeWithOptions | null> => {
  const rows = await queryAll<JoinedAttributeRow>(
    `SELECT ${ATTRIBUTE_COLS}
       FROM attributes AS attribute
       LEFT JOIN attribute_options AS attributeOption
         ON attributeOption.attribute_id = attribute.id
      WHERE attribute.id = ?
      ORDER BY attributeOption.sort_order, attributeOption.id`,
    [id],
  );
  const [attribute] = await groupAttributeRows(rows);
  return attribute ?? null;
};

export const assignNextAttributeSortOrder = async (
  attributeId: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [attributeId, attributeId],
      sql: `UPDATE attributes
            SET sort_order = COALESCE(
              (SELECT MAX(sort_order) FROM attributes WHERE id != ?), 0
            ) + 1
            WHERE id = ?`,
    },
  ]);
};

export const getNextAttributeOptionSortOrder = async (
  attributeId: number,
): Promise<number> =>
  (await queryOne<{ next_order: number }>(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM attribute_options WHERE attribute_id = ?",
    [attributeId],
  ))!.next_order;

export const swapAttributeOrder = (id1: number, id2: number): Promise<void> =>
  swapSortOrder("attributes", id1, id2);

export const swapAttributeOptionOrder = (
  id1: number,
  id2: number,
): Promise<void> => swapSortOrder("attribute_options", id1, id2);

export const deleteAttributeOption = async (
  optionId: number,
): Promise<void> => {
  await executeBatch([
    {
      args: [optionId],
      sql: "DELETE FROM listing_attribute_options WHERE option_id = ?",
    },
    { args: [optionId], sql: "DELETE FROM attribute_options WHERE id = ?" },
  ]);
};

export const deleteAttribute = async (attributeId: number): Promise<void> => {
  await executeBatch([
    {
      args: [attributeId],
      sql:
        "DELETE FROM listing_attribute_options WHERE option_id IN " +
        "(SELECT id FROM attribute_options WHERE attribute_id = ?)",
    },
    {
      args: [attributeId],
      sql: "DELETE FROM attribute_options WHERE attribute_id = ?",
    },
    { args: [attributeId], sql: "DELETE FROM attributes WHERE id = ?" },
  ]);
};

const selectedOptionRows = (
  listingIds: number[],
): Promise<SelectedAttributeRow[]> =>
  listingIds.length === 0
    ? Promise.resolve([])
    : queryAll<SelectedAttributeRow>(
        `SELECT listingAttribute.listing_id, ${ATTRIBUTE_COLS}
           FROM listing_attribute_options AS listingAttribute
           JOIN attribute_options AS attributeOption
             ON attributeOption.id = listingAttribute.option_id
           JOIN attributes AS attribute
             ON attribute.id = attributeOption.attribute_id
          WHERE listingAttribute.listing_id IN (${inPlaceholders(listingIds)})
          ORDER BY listingAttribute.listing_id,
                   attribute.sort_order, attribute.id,
                   attributeOption.sort_order, attributeOption.id`,
        listingIds,
      );

const selectedRowsForListing = (
  rows: SelectedAttributeRow[],
): Map<number, JoinedAttributeRow[]> =>
  reduce(
    (acc: Map<number, JoinedAttributeRow[]>, row: SelectedAttributeRow) => {
      const listingRows = acc.get(row.listing_id) ?? [];
      listingRows.push(row);
      return acc.set(row.listing_id, listingRows);
    },
    new Map<number, JoinedAttributeRow[]>(),
  )(rows);

export const getSelectedAttributesForListings = async (
  listingIds: number[],
): Promise<ListingAttributesById> => {
  const rowsByListing = selectedRowsForListing(
    await selectedOptionRows(unique(listingIds)),
  );
  const entries = await Promise.all(
    [...rowsByListing].map(
      async ([listingId, rows]) =>
        [listingId, await groupAttributeRows(rows)] as const,
    ),
  );
  return new Map(entries);
};

export const getListingAttributeOptionIds = (
  listingId: number,
): Promise<number[]> => listingAttributeOptions.getIds(listingId);

export const setListingAttributeOptions = async (
  listingId: number,
  optionIds: number[],
): Promise<void> =>
  listingAttributeOptions.setIds(listingId, unique(optionIds));

export const optionIdsForAttributes = (
  attributes: AttributeWithOptions[],
): number[] =>
  attributes.flatMap((attribute) =>
    map((option: AttributeOption) => option.id)(attribute.options),
  );

export const pruneInvalidAttributeOptionIds = (
  allAttributes: AttributeWithOptions[],
  optionIds: number[],
): number[] => {
  const valid = new Set(optionIdsForAttributes(allAttributes));
  return optionIds.filter((id) => valid.has(id));
};
