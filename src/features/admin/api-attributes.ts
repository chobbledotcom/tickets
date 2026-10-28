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
import { OWNER_API } from "#routes/auth.ts";
import { reReadResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { apiChildSurface } from "#shared/rest/child-surface.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  requireEntityField,
  withRequiredText,
} from "#shared/rest/crud-parsers.ts";
import { appendOnCreate } from "#shared/rest/crud-side-effects.ts";
import { okResult, type Result } from "#shared/result.ts";

/** JSON body accepted by POST /api/admin/attributes */
export type CreateAttributeBody = { name: string };

/** JSON body accepted by PUT /api/admin/attributes/:attributeId */
export type UpdateAttributeBody = { name?: string };

// The body a POST or PUT on an attribute option accepts is the table's
// AdminApiOptionBody. DELETE /api/admin/attributes/:attributeId and
// DELETE /api/admin/attributes/:attributeId/options/:optionId take the shared
// DeleteBody the crud-parsers module exports.

/** The attribute's input for a create or an update. The name goes through
 *  the shared entity-name rule, which refuses a supplied non-string with
 *  the field-named message. */
const toAttributeInput = (
  body: Record<string, unknown>,
  existing: Attribute | null,
): Result<{ name: string }> => {
  const name = requireEntityField(body, "name", existing?.name ?? null);
  return name.ok ? okResult({ name: name.value }) : name;
};

/** The option write routes' parent-and-child gate. The importer creates an
 *  attribute and immediately posts its first option, so the parent read pins
 *  to the primary. A lagging replica must not 404 the row the create just
 *  made. */
const optionSurface = apiChildSurface({
  childIdParam: "optionId",
  childLabel: "Attribute option",
  childrenOf: (attribute: AttributeWithOptions) => attribute.options,
  lookup: getAttributeWithOptionsOnPrimary,
  parentIdParam: "attributeId",
  parentLabel: "Attribute",
  policy: OWNER_API,
});

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
  getAll: getAllAttributesWithOptions,
  lookup: getAttributeWithOptions,
  // Read-your-writes: the create/update response re-reads the row and its
  // options from the primary. A lagging replica cannot answer without the
  // row the write just made.
  lookupAfterWrite: getAttributeWithOptionsOnPrimary,
  nameField: "name",
  onDelete: (id) => deleteAttribute(Number(id)),
  policy: OWNER_API,
  sideEffect: appendOnCreate(attributesOrder),
  table: attributesTable,
  toCreateInput: (body) => toAttributeInput(body, null),
  toUpdateInput: toAttributeInput,
});
