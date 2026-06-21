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
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { ADMIN_API, type AuthPolicy, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { Table } from "#shared/db/table.ts";
import type { AdminSession } from "#shared/types.ts";

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
export type ParseResult<Input> =
  | { ok: true; input: Input }
  | { ok: false; error: string };

/** JSON error response for API endpoints */
export const apiErrorResponse = (message: string, status = 400): Response =>
  jsonResponse({ error: message }, status);

/** Result of parsing + validating: either the input or a pre-built error response */
export type ValidatedInput<Input> =
  | { ok: true; input: Input }
  | { ok: false; response: Response };

/**
 * Parse + validate a JSON body into a typed input, returning a ready-to-return
 * error response on failure. Used by route handlers to short-circuit on error.
 */
export const parseAndValidate = async <Input>(
  parsed: ParseResult<Input> | Promise<ParseResult<Input>>,
  validate?: (input: Input, id?: number) => Promise<string | null>,
  id?: number,
): Promise<ValidatedInput<Input>> => {
  const result = await parsed;
  if (!result.ok) {
    return { ok: false, response: apiErrorResponse(result.error) };
  }
  if (validate) {
    const error = await validate(result.input, id);
    if (error) return { ok: false, response: apiErrorResponse(error) };
  }
  return { input: result.input, ok: true };
};

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
    ? { error: "name cannot be empty", ok: false }
    : { name, ok: true };
};

/** Configuration for defineCrudApi */
export interface CrudApiConfig<Row, Input, FullRow extends Row = Row> {
  /** Validate + persist body-only side effects (e.g. relationship edges) after
   * the row is written on create/update, given the written full row (the parent
   * in its final state) and the raw body. Returns an error message — reported as
   * a 400 with the edges left unwritten — or null on success. */
  afterWrite?: (
    row: FullRow,
    body: Record<string, unknown>,
  ) => Promise<string | null>;
  /** Extra route entries to merge in (can also override generated routes) */
  extraRoutes?: Record<string, RouteHandlerFn>;
  /** Fetch all rows (from cache) — may return a richer row type than the table (e.g. joined counts) */
  getAll: () => Promise<FullRow[]>;
  /** When true, activity log entries for create/update are linked to the row's id as listing_id */
  linkActivityToRow?: boolean;
  /** Extra keys added to the list response alongside the row array (e.g. admin_level) */
  listExtras?: (session: AdminSession) => Record<string, unknown>;
  /** Custom single-row lookup (e.g. to include joined counts). Defaults to table.findById. */
  lookup?: (id: number) => Promise<FullRow | null>;
  /** Resource name (lowercase plural, used in routes and log messages) */
  name: string;
  /** Field on Row that holds the display name (for delete confirmation) */
  nameField: keyof FullRow & string;
  /** Custom delete logic (e.g. cascade). If not provided, uses table.deleteById */
  onDelete?: (id: InValue) => Promise<void>;
  /** Auth policy for all generated routes. Defaults to ADMIN_API (any admin);
   * pass OWNER_API for resources whose web management is owner-only. */
  policy?: AuthPolicy<"json">;
  /** Singular display name for activity log (e.g. "Holiday") */
  singular: string;
  /** Keys to strip from response (e.g. "slug_index") */
  stripKeys?: string[];
  /** Table with CRUD operations */
  table: Table<Row, Input>;
  /** Convert JSON body to Input for create */
  toCreateInput: (
    body: Record<string, unknown>,
  ) => ParseResult<Input> | Promise<ParseResult<Input>>;
  /** Convert JSON body + existing row to Input for update */
  toUpdateInput: (
    body: Record<string, unknown>,
    existing: FullRow,
  ) => ParseResult<Input> | Promise<ParseResult<Input>>;
  /** Optional validation (return error message or null) */
  validate?: (input: Input, id?: number) => Promise<string | null>;
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
  policy: AuthPolicy<"json"> = ADMIN_API,
): Promise<Response> =>
  withAuth(request, policy, async (session, body) => {
    const row = await lookup(id);
    if (!row) return apiErrorResponse(`${notFoundLabel} not found`, 404);
    return handler(row, session, body);
  });

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
export const defineCrudApi = <
  Row extends { id: number; name: string },
  Input,
  FullRow extends Row = Row,
>(
  config: CrudApiConfig<Row, Input, FullRow>,
): Record<string, RouteHandlerFn> => {
  const { name, singular, table, getAll, nameField, stripKeys = [] } = config;
  const policy = config.policy ?? ADMIN_API;
  const responseKey = singular.toLowerCase();
  const listKey = name;
  const lookup: (id: number) => Promise<FullRow | null> =
    config.lookup ??
    ((id) => table.findById(id) as unknown as Promise<FullRow | null>);

  /** Clean a row for JSON response */
  const toResponse = (row: FullRow) => stripRow(row, stripKeys);

  /** Log create/update, optionally linking to the row's id as listing_id */
  const logAction = (action: string, row: Row): Promise<unknown> =>
    logActivity(
      `${singular} '${row.name}' ${action}`,
      config.linkActivityToRow ? row : undefined,
    );

  /** Re-fetch the full row when a custom lookup is configured, otherwise reuse the written row */
  const toFullRow = async (row: Row): Promise<FullRow> =>
    config.lookup
      ? (await config.lookup(row.id))!
      : (row as unknown as FullRow);

  /** List all */
  const handleList: RouteHandlerFn = (request) =>
    withAuth(request, policy, async (session) => {
      const rows = await getAll();
      const extras = config.listExtras ? config.listExtras(session) : {};
      return jsonResponse({ [listKey]: rows.map(toResponse), ...extras });
    });

  /** Finish a create/update: hydrate the full row, run the body-only side
   * effects (rejecting with a 400 — edges unwritten — on their error), log, and
   * return the row JSON. Shared so create and update apply afterWrite once. */
  const persistAndRespond = async (
    row: Row,
    body: Record<string, unknown>,
    action: string,
    status: number,
  ): Promise<Response> => {
    const fullRow = await toFullRow(row);
    const writeError = await config.afterWrite?.(fullRow, body);
    if (writeError) return apiErrorResponse(writeError);
    await logAction(action, row);
    return jsonResponse({ [responseKey]: toResponse(fullRow) }, status);
  };

  /** Create */
  const handleCreate: RouteHandlerFn = (request) =>
    withAuth(request, policy, async (_session, body) => {
      const result = await parseAndValidate(
        config.toCreateInput(body),
        config.validate,
      );
      if (!result.ok) return result.response;

      const row = await table.insert(result.input);
      return persistAndRespond(row, body, "created", 201);
    });

  // Build the route param name from the singular (e.g. "Holiday" → "holidayId")
  const paramName = `${singular.toLowerCase()}Id`;

  /** Route handler that extracts the entity ID and loads the full row, delegating to handler */
  const entityRoute = (
    handler: (
      row: FullRow,
      session: AdminSession,
      body: Record<string, unknown>,
      id: number,
    ) => Promise<Response>,
  ): RouteHandlerFn => {
    const getId = (
      params: Record<string, string | number | undefined>,
    ): number => params[paramName] as number;
    return (request, params) =>
      withApiEntity(
        request,
        lookup,
        getId(params),
        singular,
        (row, s, b) => handler(row, s, b, getId(params)),
        policy,
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
      config.validate,
      id,
    );
    if (!result.ok) return result.response;

    const row = (await table.update(existing.id, result.input))!;
    return persistAndRespond(row, body, "updated", 200);
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
    ...(config.extraRoutes ?? {}),
  };
};
