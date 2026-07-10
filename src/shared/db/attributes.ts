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

type DecryptedAttributeRows = {
  attributes: Map<number, Attribute>;
  options: Map<number, AttributeOption>;
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

const rowAttribute = (row: JoinedAttributeRow): Attribute => ({
  id: row.attribute_id,
  name: row.attribute_name,
  sort_order: row.attribute_sort_order,
});

const collectUniqueAttributes = (
  acc: Map<number, Attribute>,
  row: JoinedAttributeRow,
): Map<number, Attribute> =>
  acc.has(row.attribute_id)
    ? acc
    : acc.set(row.attribute_id, rowAttribute(row));

const collectUniqueOptions = (
  acc: Map<number, AttributeOption>,
  row: JoinedAttributeRow,
): Map<number, AttributeOption> => {
  const option = rowOption(row);
  return option && !acc.has(option.id) ? acc.set(option.id, option) : acc;
};

const decryptAttributeRows = async (
  rows: JoinedAttributeRow[],
): Promise<DecryptedAttributeRows> => {
  const [attributes, options] = await Promise.all([
    Promise.all(
      [
        ...reduce(collectUniqueAttributes, new Map<number, Attribute>())(rows),
      ].map(
        async ([id, attribute]) =>
          [id, await attributesTable.fromDb(attribute)] as const,
      ),
    ),
    Promise.all(
      [
        ...reduce(
          collectUniqueOptions,
          new Map<number, AttributeOption>(),
        )(rows),
      ].map(
        async ([id, option]) =>
          [id, await attributeOptionsTable.fromDb(option)] as const,
      ),
    ),
  ]);
  return {
    attributes: new Map(attributes),
    options: new Map(options),
  };
};

const known = <T>(items: Map<number, T>, id: number): T => items.get(id)!;

const buildAttributeGroups = (
  rows: JoinedAttributeRow[],
  decrypted: DecryptedAttributeRows,
): AttributeWithOptions[] => [
  ...reduce(
    (acc: Map<number, AttributeWithOptions>, row: JoinedAttributeRow) => {
      const group = acc.get(row.attribute_id) ?? {
        ...known(decrypted.attributes, row.attribute_id),
        options: [],
      };
      if (row.option_id !== null) {
        group.options.push(known(decrypted.options, row.option_id));
      }
      return acc.set(row.attribute_id, group);
    },
    new Map<number, AttributeWithOptions>(),
  )(rows).values(),
];

const queryIds = async (sql: string): Promise<number[]> =>
  map((row: { id: number }) => row.id)(await queryAll<{ id: number }>(sql));

const groupAttributeRows = async (
  rows: JoinedAttributeRow[],
): Promise<AttributeWithOptions[]> =>
  buildAttributeGroups(rows, await decryptAttributeRows(rows));

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

export const getAttributeId = async (id: number): Promise<number | null> =>
  (
    await queryOne<{ id: number }>(
      "SELECT id FROM attributes WHERE id = ? LIMIT 1",
      [id],
    )
  )?.id ?? null;

export const getAttributeIdsOrdered = async (): Promise<number[]> =>
  queryIds("SELECT id FROM attributes ORDER BY sort_order, id");

export const getAllAttributeOptionIds = async (): Promise<Set<number>> =>
  new Set(await queryIds("SELECT id FROM attribute_options"));

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
  const rows = await selectedOptionRows(unique(listingIds));
  const decrypted = await decryptAttributeRows(rows);
  return new Map(
    [...selectedRowsForListing(rows)].map(
      ([listingId, listingRows]) =>
        [listingId, buildAttributeGroups(listingRows, decrypted)] as const,
    ),
  );
};

export const setListingAttributeOptions = async (
  listingId: number,
  optionIds: number[],
): Promise<void> =>
  listingAttributeOptions.setIds(listingId, unique(optionIds));

export const pruneInvalidAttributeOptionIds = (
  validOptionIds: Set<number>,
  optionIds: number[],
): number[] => optionIds.filter((id) => validOptionIds.has(id));
