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

/* jscpd:ignore-start -- declarative record config */
export const attributeRecord = defineNamedRowRecord<
  Attribute,
  NamedSortOrderInput,
  AttributeWithOptions
>({
  activityName: "Attribute",
  api: ADMIN_API_RESOURCES.attributes,
  deleteDestination: "attributeDelete",
  getAll: getAllAttributesWithOptions,
  list: "attributes",
  load: getAttributeWithOptions,
  loadAfterWrite: getAttributeWithOptionsOnPrimary,
  onDelete: (id) => deleteAttribute(id),
  order: attributesOrder,
  saveLanding: "attribute",
  table: attributesTable,
});
/* jscpd:ignore-end */
