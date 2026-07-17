/**
 * Listing attributes: reusable multiple-choice metadata shown on listing pages.
 *
 * Attributes do not participate in booking. A listing stores selected option
 * ids only; display code resolves those ids back to ordered attribute groups.
 */

/* jscpd:ignore-start */
import { filter, groupToMap, map, reduce, sort, unique, uniqueBy } from "#fp";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import {
  deleteByFieldBatch,
  executeBatch,
  inPlaceholders,
  nextSortOrder,
  queryAll,
  queryIdColumn,
  queryOne,
} from "#shared/db/client.ts";
import {
  idAndEncryptedNameSchema,
  type NamedSortOrderInput,
} from "#shared/db/common-schema.ts";
import { linkTableSide } from "#shared/db/link-table.ts";
import {
  type ListingOption,
  listingOptionProjection,
} from "#shared/db/listings/table.ts";
import { assignNextSortOrder, swapSortOrder } from "#shared/db/query.ts";
import {
  col,
  defineTable,
  type StoredTableProjectionRow,
} from "#shared/db/table.ts";
import type { Listing } from "#shared/types.ts";
/* jscpd:ignore-end */

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

type AttributeOptionInput = {
  attributeId: number;
  sortOrder: number;
  text: string;
};

export const attributesTable = defineTable<Attribute, NamedSortOrderInput>({
  name: "attributes",
  primaryKey: "id",
  schema: {
    ...idAndEncryptedNameSchema(encrypt, decrypt),
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
    id: col.generated<number>(),
    sort_order: col.simple<number>(),
    text: col.encrypted(encrypt, decrypt),
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
      map(
        async ([id, attribute]: [number, Attribute]) =>
          [id, await attributesTable.fromDb(attribute)] as const,
      )([
        ...reduce(collectUniqueAttributes, new Map<number, Attribute>())(rows),
      ]),
    ),
    Promise.all(
      map(
        async ([id, option]: [number, AttributeOption]) =>
          [id, await attributeOptionsTable.fromDb(option)] as const,
      )([
        ...reduce(
          collectUniqueOptions,
          new Map<number, AttributeOption>(),
        )(rows),
      ]),
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
  queryIdColumn("SELECT id FROM attributes ORDER BY sort_order, id");

export const getAllAttributeOptionIds = async (): Promise<Set<number>> =>
  new Set(await queryIdColumn("SELECT id FROM attribute_options"));

type OptionListingRow = StoredTableProjectionRow<
  Listing,
  typeof listingOptionProjection.columns
> & {
  id: number;
  option_id: number;
};

export type AttributeListingUse = {
  /** The ids of the listings that selected each option, keyed by option id.
   * Options no listing uses are absent from the map. */
  listingIdsByOption: Map<number, number[]>;
  /** The distinct listings behind those ids in id order, names decrypted. */
  listings: ListingOption[];
};

/** Which listings selected each of an attribute's options, in one read: the
 * per-option listing ids plus each used listing's id, name, and active flag.
 * Only the names of listings that actually use the attribute are decrypted. */
export const getAttributeListingUse = async (
  attributeId: number,
): Promise<AttributeListingUse> => {
  const rows = await queryAll<OptionListingRow>(
    `SELECT listingAttribute.option_id,
            ${listingOptionProjection.columnsSql("listing")}
       FROM listing_attribute_options AS listingAttribute
       JOIN attribute_options AS attributeOption
         ON attributeOption.id = listingAttribute.option_id
       JOIN listings AS listing
         ON listing.id = listingAttribute.listing_id
      WHERE attributeOption.attribute_id = ?
      ORDER BY listingAttribute.option_id, listingAttribute.listing_id`,
    [attributeId],
  );
  const usedListings = sort(
    (a: OptionListingRow, b: OptionListingRow) => a.id - b.id,
  )(uniqueBy((row: OptionListingRow) => row.id)(rows));
  return {
    listingIdsByOption: groupToMap(
      (row: OptionListingRow) => row.option_id,
      (row) => row.id,
    )(rows),
    listings: await listingOptionProjection.readAll(usedListings),
  };
};

export const assignNextAttributeSortOrder = (
  attributeId: number,
): Promise<void> => assignNextSortOrder("attributes", attributeId);

export const getNextAttributeOptionSortOrder = (
  attributeId: number,
): Promise<number> =>
  nextSortOrder("attribute_options", "attribute_id", attributeId);

export const swapAttributeOrder = (id1: number, id2: number): Promise<void> =>
  swapSortOrder("attributes", id1, id2);

export const swapAttributeOptionOrder = (
  id1: number,
  id2: number,
): Promise<void> => swapSortOrder("attribute_options", id1, id2);

export const deleteAttributeOption = (optionId: number): Promise<void> =>
  deleteByFieldBatch([
    { field: "option_id", table: "listing_attribute_options", value: optionId },
    { field: "id", table: "attribute_options", value: optionId },
  ]);

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

const selectedRowsForListing = groupToMap<
  SelectedAttributeRow,
  number,
  JoinedAttributeRow
>(
  (row) => row.listing_id,
  (row) => row,
);

export const getSelectedAttributesForListings = async (
  listingIds: number[],
): Promise<ListingAttributesById> => {
  const rows = await selectedOptionRows(unique(listingIds));
  const decrypted = await decryptAttributeRows(rows);
  return new Map(
    map(
      ([listingId, listingRows]: [number, JoinedAttributeRow[]]) =>
        [listingId, buildAttributeGroups(listingRows, decrypted)] as const,
    )([...selectedRowsForListing(rows)]),
  );
};

export const pruneInvalidAttributeOptionIds = (
  validOptionIds: Set<number>,
  optionIds: number[],
): number[] => filter((id: number) => validOptionIds.has(id))(optionIds);
