/**
 * Admin JSON API routes for listing attributes and their options — accessible
 * via API key or cookie+CSRF. The dashboard's attribute routes are owner-only,
 * so the JSON API matches.
 */

import {
  type Attribute,
  type AttributeOption,
  type AttributeWithOptions,
  attributesOrder,
  attributesTable,
  deleteAttribute,
  getAllAttributesWithOptions,
  getAttributeWithOptions,
  getAttributeWithOptionsOnPrimary,
} from "#db/attributes.ts";
import type { TxScope } from "#db/client.ts";
import { byId } from "#fp";
import {
  addAttributeOptionWithLog,
  deleteAttributeOptionWithLog,
  renameAttributeOptionWithLog,
} from "#routes/admin/attributes.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { OWNER_API } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  apiEntityGate,
  requireEntityName,
  requireStrings,
} from "#shared/rest/crud-parsers.ts";
import { okResult, type Result } from "#shared/result.ts";

/** JSON body accepted by POST /api/admin/attributes */
export type CreateAttributeBody = { name: string };

/** JSON body accepted by PUT /api/admin/attributes/:attributeId */
export type UpdateAttributeBody = { name?: string };

/** JSON body accepted by POST and PUT on an attribute option */
export type AttributeOptionBody = { text: string };

// DELETE /api/admin/attributes/:attributeId and
// DELETE /api/admin/attributes/:attributeId/options/:optionId take the shared
// DeleteBody the crud-parsers module exports.

/** The attribute's input for a create or an update. The name goes through
 *  the shared entity-name rule, which refuses a supplied non-string with
 *  the field-named message. */
const toAttributeInput = (
  body: Record<string, unknown>,
  existing: Attribute | null,
): Result<{ name: string }> => {
  const name = requireEntityName(body, existing?.name ?? null);
  return name.ok ? okResult({ name: name.value }) : name;
};

/** The attribute write's only side effect: appending the order entry on create,
 * inside the row write's transaction, so an attribute never exists unplaced.
 * Renames leave the order alone. */
const orderAppend = {
  persist: async (
    transaction: TxScope,
    id: number,
    appendOrder: boolean,
    _state: null,
  ) => {
    if (appendOrder) {
      await attributesOrder.append({ key: id, transaction });
    }
  },
  validate: async (
    _input: { name: string },
    _body: Record<string, unknown>,
    existing: Attribute | null,
  ) => okResult(existing === null),
};

export const attributeCrudRoutes = defineCrudApi<
  Attribute,
  { name: string },
  AttributeWithOptions,
  boolean
>({
  getAll: getAllAttributesWithOptions,
  lookup: getAttributeWithOptions,
  // Read-your-writes: the create/update response re-reads the row and its
  // options from the primary. A lagging replica cannot answer without the
  // row the write just made.
  lookupAfterWrite: getAttributeWithOptionsOnPrimary,
  name: "attributes",
  nameField: "name",
  onDelete: (id) => deleteAttribute(Number(id)),
  policy: OWNER_API,
  sideEffect: orderAppend,
  singular: "Attribute",
  table: attributesTable,
  toCreateInput: (body) => toAttributeInput(body, null),
  toUpdateInput: toAttributeInput,
});

type AttributeOptionParams = { attributeId: number; optionId: number };

/** The gate the option write routes load their attribute through. The importer
 * creates an attribute and immediately posts its first option. The read pins
 * to the primary: a lagging replica must not 404 the row the create just
 * made. */
const attributeGateForWrite = apiEntityGate(
  getAttributeWithOptionsOnPrimary,
  "Attribute",
  OWNER_API,
);

/** Load one attribute with its options, then one of its options. 404 for an
 * unknown attribute or an option that belongs to another attribute. */
const withAttributeOption = (
  request: Request,
  params: AttributeOptionParams,
  handler: (
    context: { attribute: AttributeWithOptions; option: AttributeOption },
    body: Record<string, unknown>,
  ) => Promise<Response>,
): Promise<Response> =>
  attributeGateForWrite(
    request,
    params.attributeId,
    async (attribute, body) => {
      const option = byId(attribute.options).get(params.optionId);
      if (!option) return apiErrorResponse("Attribute option not found", 404);
      return handler({ attribute, option }, body);
    },
  );

/** Parse the body's option text, or answer the standard 400. `run` receives
 * the text. */
const withOptionText = (
  body: Record<string, unknown>,
  run: (text: string) => Promise<Response>,
): Promise<Response> => {
  const parsed = requireStrings(body, ["text"]);
  return parsed.ok
    ? run(parsed.value.text)
    : Promise.resolve(apiErrorResponse(parsed.error));
};

/** The write response: the written attribute re-read from the primary. */
const attributeResponse = async (
  attributeId: number,
  status?: number,
): Promise<Response> =>
  jsonResponse(
    { attribute: await getAttributeWithOptionsOnPrimary(attributeId) },
    status,
  );

/** POST /api/admin/attributes/:attributeId/options */
const handleOptionCreate: RouteHandlerFn = (request, params) =>
  attributeGateForWrite(
    request,
    params.attributeId as number,
    (attribute, body) =>
      withOptionText(body, async (text) => {
        await addAttributeOptionWithLog(attribute, text);
        return attributeResponse(attribute.id, 201);
      }),
  );

/** PUT /api/admin/attributes/:attributeId/options/:optionId */
const handleOptionUpdate: RouteHandlerFn = (request, params) =>
  withAttributeOption(
    request,
    params as AttributeOptionParams,
    ({ attribute, option }, body) =>
      withOptionText(body, async (text) => {
        await renameAttributeOptionWithLog(attribute, option, text);
        return attributeResponse(attribute.id);
      }),
  );

/** DELETE /api/admin/attributes/:attributeId/options/:optionId */
const handleOptionDelete: RouteHandlerFn = (request, params) =>
  withAttributeOption(
    request,
    params as AttributeOptionParams,
    async ({ attribute, option }, body) => {
      const error = verifyIdentifierOrJsonError(
        option.text,
        body.confirm_identifier,
        "Option text",
      );
      if (error) return apiErrorResponse(error);
      await deleteAttributeOptionWithLog(attribute, option);
      return jsonResponse({ status: "ok" });
    },
  );

export const attributeApiRoutes = {
  ...attributeCrudRoutes,
  "DELETE /api/admin/attributes/:attributeId/options/:optionId":
    handleOptionDelete,
  "POST /api/admin/attributes/:attributeId/options": handleOptionCreate,
  "PUT /api/admin/attributes/:attributeId/options/:optionId":
    handleOptionUpdate,
};
