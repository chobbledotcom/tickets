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
import { attributeRecord } from "#shared/records/attributes.ts";
import {
  childTextHandlers,
  recordChildSurface,
} from "#shared/rest/child-surface.ts";
import { withRequiredText, withWriteName } from "#shared/rest/crud-parsers.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { okResult } from "#shared/result.ts";

/** JSON body accepted by POST /api/admin/attributes */
export type CreateAttributeBody = { name: string };

/** JSON body accepted by PUT /api/admin/attributes/:attributeId */
export type UpdateAttributeBody = { name?: string };

/** The attribute's input for a create or an update. The schema proves the
 *  supplied value is text. An update without one keeps the stored name. */
const toAttributeInput = withWriteName<
  { name?: string | undefined },
  Attribute,
  { name: string }
>((name) => okResult({ name }));

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

/** The write response: the written attribute re-read from the primary. */
const attributeResponse = reReadResponse(
  "attribute",
  getAttributeWithOptionsOnPrimary,
);

/* jscpd:ignore-start -- declarative child-route config, one per record */
const optionHandlers = childTextHandlers({
  create: async (attribute, text) => {
    await addAttributeOptionWithLog(attribute, text);
    return attributeResponse(attribute.id, 201);
  },
  destroy: (attribute, option) =>
    deleteAttributeOptionWithLog(attribute, option),
  label: "Option text",
  reader: withRequiredText,
  surface: optionSurface,
  textOf: (option) => option.text,
  update: async (attribute, option, text) => {
    await renameAttributeOptionWithLog(attribute, option, text);
    return attributeResponse(attribute.id);
  },
});
/* jscpd:ignore-end */

export const attributeApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.attributes,
  Attribute,
  { name: string },
  AttributeWithOptions
>(attributeRecord, {
  childHandlers: { options: optionHandlers },
  toCreateInput: (body) => toAttributeInput(body, null),
  toUpdateInput: toAttributeInput,
});
