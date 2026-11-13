/**
 * The attribute record: its table, its one write rule, and its admin surface.
 * Its options are the child surface the pages and the JSON API both address.
 */

import {
  type Attribute,
  type AttributeWithOptions,
  attributesOrder,
  attributesTable,
  deleteAttribute,
  getAllAttributesWithOptions,
  getAttributeWithOptions,
  getAttributeWithOptionsOnPrimary,
} from "#db/attributes.ts";
import type { NamedSortOrderInput } from "#db/common-schema.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import { type RecordShapeOf, recordHead } from "#shared/rest/record.ts";

export const attributeRecord = defineNamedRowRecord<
  RecordShapeOf<Attribute, NamedSortOrderInput, AttributeWithOptions>
>({
  ...recordHead(
    "Attribute",
    ADMIN_API_RESOURCES.attributes,
    "attributeDelete",
    "attributes",
  ),
  onDelete: (id) => deleteAttribute(id),
  order: attributesOrder,
  reads: {
    all: getAllAttributesWithOptions,
    one: getAttributeWithOptions,
    onePrimary: getAttributeWithOptionsOnPrimary,
  },
  saveLanding: "attribute",
  table: attributesTable,
});
