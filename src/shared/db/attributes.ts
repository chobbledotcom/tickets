/**
 * Listing attributes: reusable multiple-choice metadata shown on listing pages.
 *
 * Attributes do not participate in booking. A listing stores selected option
 * ids only. Display code resolves those ids back to ordered attribute groups.
 */

import { inOneBatch, removalWithChildren } from "#db/child-rows.ts";
import {
  executeBatch,
  queryAll,
  queryIdColumn,
  queryOne,
  type TxScope,
} from "#db/client.ts";
import { linkTableSide } from "#db/link-table.ts";
import type { ListingOption } from "#db/listings/catalog.ts";
import { listWithChildOrders } from "#db/ordered-collection.ts";
import { pickedColumns } from "#db/picked-columns.ts";
import { readRows } from "#db/read.ts";
import { rowsById } from "#db/record-table.ts";
import { onReplicaAndPrimary } from "#db/replica-or-primary.ts";
import { rowsForIds } from "#db/rows-for-ids.ts";
import { equal } from "#db/select/expression.ts";
import { from, tableNode } from "#db/select/query.ts";
import { type DecodedRowOf, tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { txIdSetInTable } from "#db/transaction.ts";
import { deleteFrom } from "#db/write.ts";
import {
  filter,
  groupToMap,
  map,
  reduce,
  requiredMapValue,
  sort,
  unique,
  uniqueBy,
} from "#fp";

export type Attribute = DecodedRowOf<"attributes">;

export type AttributeOption = DecodedRowOf<"attribute_options">;

export type AttributeWithOptions = Attribute & {
  options: AttributeOption[];
};

export type ListingAttributesById = Map<number, AttributeWithOptions[]>;

export const { children: attributeOptionsOrder, list: attributesOrder } =
  listWithChildOrders("attributes", "attribute_options", "attribute_id");

export const listingAttributeOptions = linkTableSide(
  tables.listing_attribute_options,
  "listing_id",
  "option_id",
);

/** The columns of an attribute and of one of its options. The client decodes
 * the name and the text. */
const ATTRIBUTE_COLUMNS = (() => {
  const attribute = tableNode(tables.attributes, "attribute");
  const option = tableNode(tables.attribute_options, "attributeOption");
  return pickedColumns({
    attribute_id: attribute.id,
    attribute_name: attribute.name,
    attribute_sort_order: attribute.sort_order,
    option_attribute_id: option.attribute_id,
    option_id: option.id,
    option_sort_order: option.sort_order,
    option_text: option.text,
  });
})();

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

type CollectedAttributeRows = {
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

/** Each attribute and each option of the rows, by id. */
const collectAttributeRows = (
  rows: JoinedAttributeRow[],
): CollectedAttributeRows => ({
  attributes: reduce(
    collectUniqueAttributes,
    new Map<number, Attribute>(),
  )(rows),
  options: reduce(
    collectUniqueOptions,
    new Map<number, AttributeOption>(),
  )(rows),
});

const buildAttributeGroups = (
  rows: JoinedAttributeRow[],
  collected: CollectedAttributeRows,
): AttributeWithOptions[] => [
  ...reduce(
    (acc: Map<number, AttributeWithOptions>, row: JoinedAttributeRow) => {
      const group = acc.get(row.attribute_id) ?? {
        ...requiredMapValue(
          collected.attributes,
          row.attribute_id,
          `Attribute ${row.attribute_id} missing`,
        ),
        options: [],
      };
      if (row.option_id !== null) {
        group.options.push(
          requiredMapValue(
            collected.options,
            row.option_id,
            `Option ${row.option_id} missing`,
          ),
        );
      }
      return acc.set(row.attribute_id, group);
    },
    new Map<number, AttributeWithOptions>(),
  )(rows).values(),
];

const groupAttributeRows = (
  rows: JoinedAttributeRow[],
): AttributeWithOptions[] =>
  buildAttributeGroups(rows, collectAttributeRows(rows));

export const getAllAttributesWithOptions = async (): Promise<
  AttributeWithOptions[]
> =>
  groupAttributeRows(
    await queryAll<JoinedAttributeRow>(
      ATTRIBUTE_COLUMNS.decoded(
        sql`SELECT ${ATTRIBUTE_COLUMNS.list}
         FROM attributes AS attribute
         LEFT JOIN attribute_options AS attributeOption
           ON attributeOption.attribute_id = attribute.id
        ORDER BY attribute.sort_order, attribute.id,
                 attributeOption.sort_order, attributeOption.id`,
      ),
    ),
  );

const attributeJoinedSql = (id: number): SqlStatement =>
  ATTRIBUTE_COLUMNS.decoded(sql`SELECT ${ATTRIBUTE_COLUMNS.list}
       FROM attributes AS attribute
       LEFT JOIN attribute_options AS attributeOption
         ON attributeOption.attribute_id = attribute.id
      WHERE attribute.id = ${id}
      ORDER BY attributeOption.sort_order, attributeOption.id`);

const attributeFromRows = (
  rows: JoinedAttributeRow[],
): AttributeWithOptions | null => groupAttributeRows(rows)[0] ?? null;

/** One attribute with its options. A write sequence creates an attribute and
 * then its first option. The primary version cannot miss the row that the
 * create just made. */
export const {
  onPrimary: getAttributeWithOptionsOnPrimary,
  onReplica: getAttributeWithOptions,
} = onReplicaAndPrimary(attributeJoinedSql, attributeFromRows);

export const getAttributeId = async (id: number): Promise<number | null> =>
  (await queryOne(rowsById(tables.attributes, id).limit(1).pick("id")))?.id ??
  null;

export const getAttributeIdsOrdered = async (): Promise<number[]> =>
  queryIdColumn(
    from(tables.attributes).sortedBy("sort_order", "id").pick("id"),
  );

/** The submitted option ids the site has. Unknown ids drop out. The order
 * and any duplicates of the submitted list are kept. */
export const attributeOptionIdsIn = async (
  submitted: readonly number[],
): Promise<number[]> => {
  const unique = [...new Set(submitted)];
  const found = new Set(
    unique.length === 0
      ? []
      : await queryIdColumn(
          rowsById(tables.attribute_options, unique).pick("id"),
        ),
  );
  return filter((id: number) => found.has(id))(submitted);
};

/** The submitted option ids the site does not have, read through the open
 * transaction that will write the links. The check and the write see the same
 * option set, so a delete between check and write can never store an orphan.
 * The query names only the submitted ids. */
export const missingAttributeOptionIds = async (
  tx: TxScope,
  submitted: readonly number[],
): Promise<number[]> => {
  const found = await txIdSetInTable("attribute_options")(tx, submitted);
  return [...new Set(submitted)].filter((id) => !found.has(id));
};

export type AttributeListingUse = {
  /** The ids of the listings that selected each option, keyed by option id.
   * Options no listing uses are absent from the map. */
  listingIdsByOption: Map<number, number[]>;
  /** The distinct listings behind those ids in id order. */
  listings: ListingOption[];
};

/** Which listings selected each of an attribute's options, in one read: the
 * per-option listing ids plus each used listing's id, name, and active flag.
 * Only the names of listings that actually use the attribute are read. */
export const getAttributeListingUse = async (
  attributeId: number,
): Promise<AttributeListingUse> => {
  const rows = await readRows(
    from(tables.listing_attribute_options, { listing: {}, option: {} })
      .where((link) => equal(link.option.attribute_id, attributeId))
      .sortedBy("option_id", "listing_id")
      .select((link) => ({
        active: link.listing.active,
        id: link.listing.id,
        name: link.listing.name,
        option_id: link.option_id,
      })),
  );
  type OptionListingRow = (typeof rows)[number];
  const usedListings = sort(
    (a: OptionListingRow, b: OptionListingRow) => a.id - b.id,
  )(uniqueBy((row: OptionListingRow) => row.id)(rows));
  return {
    listingIdsByOption: groupToMap(
      (row: OptionListingRow) => row.option_id,
      (row) => row.id,
    )(rows),
    listings: usedListings.map(({ active, id, name }) => ({
      active,
      id,
      name,
    })),
  };
};

/** The deletes that remove attribute options with their listing links. */
const optionRemoval = removalWithChildren(tables.attribute_options, [
  [tables.listing_attribute_options, "option_id"],
]);

export const deleteAttributeOption = inOneBatch(optionRemoval);

export const deleteAttribute = (attributeId: number): Promise<void> =>
  executeBatch([
    ...optionRemoval(
      from(tables.attribute_options)
        .where({ attribute_id: attributeId })
        .values((option) => option.id),
    ),
    deleteFrom(tables.attributes).where({ id: attributeId }),
  ]);

const selectedOptionRows = (
  listingIds: number[],
): Promise<SelectedAttributeRow[]> =>
  rowsForIds<SelectedAttributeRow>(listingIds, (idSlots) =>
    ATTRIBUTE_COLUMNS.decoded(
      sql`SELECT listingAttribute.listing_id, ${ATTRIBUTE_COLUMNS.list}
           FROM listing_attribute_options AS listingAttribute
           JOIN attribute_options AS attributeOption
             ON attributeOption.id = listingAttribute.option_id
           JOIN attributes AS attribute
             ON attribute.id = attributeOption.attribute_id
          WHERE listingAttribute.listing_id IN (${idSlots})
          ORDER BY listingAttribute.listing_id,
                   attribute.sort_order, attribute.id,
                   attributeOption.sort_order, attributeOption.id`,
    ),
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
  const collected = collectAttributeRows(rows);
  return new Map(
    map(
      ([listingId, listingRows]: [number, JoinedAttributeRow[]]) =>
        [listingId, buildAttributeGroups(listingRows, collected)] as const,
    )([...selectedRowsForListing(rows)]),
  );
};
