/**
 * Generic CRUD API factory — generates JSON API routes for simple resources.
 *
 * Reuses existing table definitions and validation, adding a thin JSON
 * body → camelCase input conversion layer on top.
 *
 * Usage:
 *   const routes = defineCrudApi({
 *     name: "holidays",
 *     table: holidaysTable,
 *     getAll: getAllHolidays,
 *     fields: [...],
 *     toInput: (body) => ({ ... }),
 *     toUpdateInput: (body, existing) => ({ ... }),
 *     validate: (input) => ...,
 *     nameField: "name",
 *   });
 */

import type { InValue } from "@libsql/client";
import { logActivity } from "#lib/db/activityLog.ts";
import type { Table } from "#lib/db/table.ts";
import type { AdminSession } from "#lib/types.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/utils.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { ADMIN_API, jsonResponse, withAuth } from "#routes/utils.ts";

/** JSON body for confirmed delete endpoints */
export type DeleteBody = { confirm_identifier: string };

/**
 * Parse a required non-empty string field from a JSON body.
 * Returns the trimmed string or null if missing/empty.
 */
export const requireString = (
  body: Record<string, unknown>,
  key: string,
): string | null =>
  typeof body[key] === "string" && body[key].trim() !== ""
    ? body[key].trim()
    : null;

/** Result of parsing a JSON body into a typed input */
type ParseResult<Input> =
  | { ok: true; input: Input }
  | { ok: false; error: string };

/** JSON error response for API endpoints */
export const apiErrorResponse = (message: string, status = 400): Response =>
  jsonResponse({ status: "error", message }, status);

/**
 * Parse an optional slug field from a JSON body for update operations.
 * Returns the normalized slug and computed index, falling back to the existing slug.
 */
export const parseUpdateSlug = async (
  body: Record<string, unknown>,
  existing: string,
  normalize: (slug: string) => string,
  computeIndex: (slug: string) => Promise<string>,
): Promise<{ slug: string; slugIndex: string }> => {
  const slug = body.slug != null ? normalize(String(body.slug)) : existing;
  return { slug, slugIndex: await computeIndex(slug) };
};

/**
 * Parse a name field from a JSON body for update operations.
 * Returns the trimmed name from the body (if provided), or falls back to the existing value.
 * Returns an error result if the resolved name is empty.
 */
export const parseUpdateName = (
  body: Record<string, unknown>,
  existing: string,
): { ok: true; name: string } | { ok: false; error: string } => {
  const name = body.name != null ? String(body.name).trim() : existing;
  return name === ""
    ? { ok: false, error: "name cannot be empty" }
    : { ok: true, name };
};

/** Configuration for defineCrudApi */
export interface CrudApiConfig<Row, Input> {
  /** Resource name (lowercase plural, used in routes and log messages) */
  name: string;
  /** Singular display name for activity log (e.g. "Holiday") */
  singular: string;
  /** Table with CRUD operations */
  table: Table<Row, Input>;
  /** Fetch all rows (from cache) */
  getAll: () => Promise<Row[]>;
  /** Convert JSON body to Input for create */
  toCreateInput: (
    body: Record<string, unknown>,
  ) => ParseResult<Input> | Promise<ParseResult<Input>>;
  /** Convert JSON body + existing row to Input for update */
  toUpdateInput: (
    body: Record<string, unknown>,
    existing: Row,
  ) => ParseResult<Input> | Promise<ParseResult<Input>>;
  /** Optional validation (return error message or null) */
  validate?: (input: Input, id?: number) => Promise<string | null>;
  /** Field on Row that holds the display name (for delete confirmation) */
  nameField: keyof Row & string;
  /** Keys to strip from response (e.g. "slug_index") */
  stripKeys?: string[];
  /** Custom delete logic (e.g. cascade). If not provided, uses table.deleteById */
  onDelete?: (id: InValue) => Promise<void>;
}

/** Callback receiving an entity row plus auth context */
type EntityHandler<Row> = (
  row: Row,
  session: AdminSession,
  body: Record<string, unknown>,
) => Promise<Response>;

/**
 * Auth + entity lookup helper.
 * Calls withAuth, fetches the entity by ID, and passes it to the callback.
 * Returns 404 automatically if the entity doesn't exist.
 */
export const withApiEntity = <Row>(
  request: Request,
  lookup: (id: number) => Promise<Row | null>,
  id: number,
  notFoundLabel: string,
  handler: EntityHandler<Row>,
): Promise<Response> =>
  withAuth(request, ADMIN_API, async (session, body) => {
    const row = await lookup(id);
    if (!row) return apiErrorResponse(`${notFoundLabel} not found`, 404);
    return handler(row, session, body);
  });

/** Config-aware entity lookup */
const withEntity = <Row, Input>(
  config: CrudApiConfig<Row, Input>,
  request: Request,
  id: number,
  handler: EntityHandler<Row>,
): Promise<Response> =>
  withApiEntity(
    request,
    (i) => config.table.findById(i),
    id,
    config.singular,
    handler,
  );

/** Strip internal keys from a row before sending in the response */
const stripRow = <Row>(row: Row, keys: string[]): Record<string, unknown> => {
  if (keys.length === 0) return row as Record<string, unknown>;
  const result = { ...(row as Record<string, unknown>) };
  for (const key of keys) delete result[key];
  return result;
};

/**
 * Define CRUD API routes for a resource.
 *
 * Generates:
 *   GET    /api/admin/{name}          — list all
 *   GET    /api/admin/{name}/:id      — get one
 *   POST   /api/admin/{name}          — create
 *   PUT    /api/admin/{name}/:id      — update
 *   DELETE /api/admin/{name}/:id      — delete (with confirm_identifier)
 */
export const defineCrudApi = <Row extends { id: number; name: string }, Input>(
  config: CrudApiConfig<Row, Input>,
): Record<string, RouteHandlerFn> => {
  const { name, singular, table, getAll, nameField, stripKeys = [] } = config;
  const responseKey = singular.toLowerCase();
  const listKey = name;

  /** Clean a row for JSON response */
  const toResponse = (row: Row) => stripRow(row, stripKeys);

  /** Parse input and run validation, returning error response or validated input */
  const parseAndValidate = async (
    parsed: ParseResult<Input> | Promise<ParseResult<Input>>,
    id?: number,
  ): Promise<
    { ok: true; input: Input } | { ok: false; response: Response }
  > => {
    const result = await parsed;
    if (!result.ok)
      return { ok: false, response: apiErrorResponse(result.error) };
    if (config.validate) {
      const error = await config.validate(result.input, id);
      if (error) return { ok: false, response: apiErrorResponse(error) };
    }
    return { ok: true, input: result.input };
  };

  /** List all */
  const handleList: RouteHandlerFn = (request) =>
    withAuth(request, ADMIN_API, async () => {
      const rows = await getAll();
      return jsonResponse({ [listKey]: rows.map(toResponse) });
    });

  /** Create */
  const handleCreate: RouteHandlerFn = (request) =>
    withAuth(request, ADMIN_API, async (_session, body) => {
      const result = await parseAndValidate(config.toCreateInput(body));
      if (!result.ok) return result.response;

      const row = await table.insert(result.input);
      await logActivity(`${singular} '${row.name}' created`);
      return jsonResponse({ [responseKey]: toResponse(row) }, 201);
    });

  // Build the route param name from the singular (e.g. "Holiday" → "holidayId")
  const paramName = `${singular.toLowerCase()}Id`;

  /** Route handler that extracts the entity ID from params and delegates to withEntity */
  const entityRoute = (
    handler: (
      row: Row,
      session: AdminSession,
      body: Record<string, unknown>,
      id: number,
    ) => Promise<Response>,
  ): RouteHandlerFn => {
    const getId = (
      params: Record<string, string | number | undefined>,
    ): number => params[paramName] as number;
    return (request, params) =>
      withEntity(config, request, getId(params), (row, session, body) =>
        handler(row, session, body, getId(params)),
      );
  };

  /** Get single */
  const handleGet = entityRoute((row) =>
    Promise.resolve(jsonResponse({ [responseKey]: toResponse(row) })),
  );

  /** Update */
  const handleUpdate = entityRoute(async (existing, _session, body, id) => {
    const result = await parseAndValidate(
      config.toUpdateInput(body, existing),
      id,
    );
    if (!result.ok) return result.response;

    const row = (await table.update(existing.id, result.input))!;
    await logActivity(`${singular} '${row.name}' updated`);
    return jsonResponse({ [responseKey]: toResponse(row) });
  });

  /** Delete */
  const handleDelete = entityRoute(async (existing, _session, body) => {
    const error = verifyIdentifierOrJsonError(
      String(existing[nameField]),
      body.confirm_identifier,
      `${singular} name`,
    );
    if (error) return apiErrorResponse(error);

    if (config.onDelete) {
      await config.onDelete(existing.id);
    } else {
      await table.deleteById(existing.id);
    }
    await logActivity(`${singular} '${existing.name}' deleted`);
    return jsonResponse({ status: "ok" });
  });

  return {
    [`GET /api/admin/${name}`]: handleList,
    [`GET /api/admin/${name}/:${paramName}`]: handleGet,
    [`POST /api/admin/${name}`]: handleCreate,
    [`PUT /api/admin/${name}/:${paramName}`]: handleUpdate,
    [`DELETE /api/admin/${name}/:${paramName}`]: handleDelete,
  };
};
