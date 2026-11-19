/**
 * Admin JSON API routes for listing attributes and their options — accessible
 * via API key or cookie+CSRF. The audience and the write path come from the
 * attribute record.
 */

import {
  type Attribute,
  type AttributeOption,
  type AttributeWithOptions,
  getAttributeWithOptionsOnPrimary,
} from "#db/attributes.ts";
import {
  addAttributeOptionWithLog,
  deleteAttributeOptionWithLog,
  renameAttributeOptionWithLog,
} from "#routes/admin/attributes.ts";
import { reReadResponse } from "#routes/response.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { snakeCaseKeys } from "#shared/column-names.ts";
import { ATTRIBUTE_FIELDS } from "#shared/records/attribute-fields.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { requireValue } from "#shared/required-value.ts";
import type { ApiBody } from "#shared/rest/api-body-fields.ts";
import {
  childTextConfig,
  recordChildSurface,
} from "#shared/rest/child-surface.ts";
import { withRequiredText } from "#shared/rest/crud-parsers.ts";
import { bodyMappers } from "#shared/rest/field-reads.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";

/** JSON body accepted by POST /api/admin/attributes */
export type CreateAttributeBody = ApiBody<
  typeof ADMIN_API_RESOURCES.attributes.createBodySchema
>;

/** JSON body accepted by PUT /api/admin/attributes/:attributeId */
export type UpdateAttributeBody = ApiBody<
  typeof ADMIN_API_RESOURCES.attributes.updateBodySchema
>;

/** The option write routes' parent-and-child gate. The importer creates an
 *  attribute and immediately posts its first option, so the parent read pins
 *  to the primary. A lagging replica must not 404 the row the create just
 *  made. */
const optionSurface = recordChildSurface<AttributeWithOptions, AttributeOption>(
  attributeRecord,
  "attributeId",
  "Attribute",
  "optionId",
  "Attribute option",
  getAttributeWithOptionsOnPrimary,
  (attribute) => attribute.options,
);

/** The options as the JSON API sends them: under their column names. */
const wireOptions = (options: readonly AttributeOption[]) =>
  options.map(snakeCaseKeys);

/** One attribute as the JSON API sends it: the attribute and each of its
 *  options under their column names. */
const wireAttribute = (attribute: AttributeWithOptions) => ({
  ...snakeCaseKeys(attribute),
  options: wireOptions(attribute.options),
});

/** The write response: the written attribute re-read from the primary. */
const attributeResponse = reReadResponse("attribute", async (id: number) =>
  wireAttribute(
    requireValue(
      await getAttributeWithOptionsOnPrimary(id),
      `Attribute ${id} was not found after its option write`,
    ),
  ),
);

const optionHandlers = childTextConfig(
  optionSurface,
  "Option text",
  withRequiredText,
  (option) => option.text,
  {
    add: addAttributeOptionWithLog,
    remove: deleteAttributeOptionWithLog,
    rename: renameAttributeOptionWithLog,
    respond: attributeResponse,
  },
);

export const attributeApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.attributes,
  RecordShapeOf<Attribute, { name: string }, AttributeWithOptions>
>(attributeRecord, {
  childHandlers: { options: optionHandlers },
  ...bodyMappers(ATTRIBUTE_FIELDS),
  // The record API renames only the top-level keys. The row came from an
  // AttributeWithOptions, so its options are attribute option rows.
  projectResponse: (row) => ({
    ...row,
    options: wireOptions(row.options as AttributeOption[]),
  }),
});
