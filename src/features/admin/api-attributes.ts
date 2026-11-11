/**
 * Admin JSON API routes for listing attributes and their options — accessible
 * via API key or cookie+CSRF. The dashboard's attribute routes are owner-only,
 * so the JSON API matches.
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
import {
  addAttributeOptionWithLog,
  deleteAttributeOptionWithLog,
  renameAttributeOptionWithLog,
} from "#routes/admin/attributes.ts";
import { reReadResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { ownerChildSurface } from "#shared/rest/child-surface.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import { ownerCatalogConfig } from "#shared/rest/crud-config.ts";
import { withRequiredText, withWriteName } from "#shared/rest/crud-parsers.ts";
import { appendOnCreate } from "#shared/rest/crud-side-effects.ts";
import { okResult } from "#shared/result.ts";

/** JSON body accepted by POST /api/admin/attributes */
export type CreateAttributeBody = { name: string };

/** JSON body accepted by PUT /api/admin/attributes/:attributeId */
export type UpdateAttributeBody = { name?: string };

// The body a POST or PUT on an attribute option accepts is the table's
// AdminApiOptionBody. DELETE /api/admin/attributes/:attributeId and
// DELETE /api/admin/attributes/:attributeId/options/:optionId take the shared
// DeleteBody the crud-parsers module exports.

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
const optionSurface = ownerChildSurface(
  "attributeId",
  "Attribute",
  "optionId",
  "Attribute option",
  getAttributeWithOptionsOnPrimary,
  (attribute: AttributeWithOptions) => attribute.options,
);

/** The write response: the written attribute re-read from the primary. */
const attributeResponse = reReadResponse(
  "attribute",
  getAttributeWithOptionsOnPrimary,
);

/** POST /api/admin/attributes/:attributeId/options */
const handleOptionCreate: RouteHandlerFn = (request, params) =>
  optionSurface.parent(request, params, (attribute, body) =>
    withRequiredText(body, async (text) => {
      await addAttributeOptionWithLog(attribute, text);
      return attributeResponse(attribute.id, 201);
    }),
  );

/** PUT /api/admin/attributes/:attributeId/options/:optionId */
const handleOptionUpdate = optionSurface.textUpdate(
  withRequiredText,
  async (attribute, option, text) => {
    await renameAttributeOptionWithLog(attribute, option, text);
    return attributeResponse(attribute.id);
  },
);

/** DELETE /api/admin/attributes/:attributeId/options/:optionId */
const handleOptionDelete = optionSurface.confirmedDelete(
  (option) => option.text,
  "Option text",
  (attribute, option) => deleteAttributeOptionWithLog(attribute, option),
);

export const attributeApiRoutes = defineCrudApi<
  typeof ADMIN_API_RESOURCES.attributes,
  Attribute,
  { name: string },
  Attribute,
  boolean
>(ADMIN_API_RESOURCES.attributes, {
  childHandlers: {
    options: {
      create: handleOptionCreate,
      delete: handleOptionDelete,
      update: handleOptionUpdate,
    },
  },
  ...ownerCatalogConfig(
    getAllAttributesWithOptions,
    getAttributeWithOptions,
    getAttributeWithOptionsOnPrimary,
    "name",
    (id) => deleteAttribute(Number(id)),
    attributesTable,
  ),
  sideEffect: appendOnCreate(attributesOrder),
  toCreateInput: (body) => toAttributeInput(body, null),
  toUpdateInput: toAttributeInput,
});
