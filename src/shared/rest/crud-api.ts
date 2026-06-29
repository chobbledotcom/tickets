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
import { type TxScope, withTransaction } from "#shared/db/client.ts";
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

/** Outcome of parsing a single array element: a value, or a rejection reason. */
export type ItemResult<T> = { value: T } | { error: string };

/**
 * Parse an optional JSON-array field with partial-update semantics, failing
 * closed. `undefined` → ok with `undefined` (caller leaves existing data
 * untouched); a non-array → error; otherwise every element runs through
 * `parseItem` and the first rejection fails the whole parse (so a malformed
 * entry can't be silently dropped into a destructive replacement).
 */
export const parseOptionalArray = <T>(
  raw: unknown,
  label: string,
  parseItem: (item: unknown) => ItemResult<T>,
): ParseResult<T[] | undefined> => {
  if (raw === undefined) return { input: undefined, ok: true };
  if (!Array.isArray(raw)) {
    return { error: `${label} must be an array`, ok: false };
  }
  const items: T[] = [];
  for (const item of raw) {
    const parsed = parseItem(item);
    if ("error" in parsed) return { error: parsed.error, ok: false };
    items.push(parsed.value);
  }
  return { input: items, ok: true };
};

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

/**
 * An atomic body-only side effect (e.g. relationship edges) for a create/update
 * (parents.md Fix 4). Two-phase so the whole write is all-or-nothing:
 * `validate` runs BEFORE the write and either rejects (400, nothing written) or
 * yields a prepared `value`; `persist` then runs in the SAME transaction as the
 * row write (see `writeWithSideEffect`), so a failure rolls the row write back
 * too — never an orphan row without its side effect. A resource with no side
 * effects omits it and takes the plain (untransacted) single-statement path.
 */
export interface CrudSideEffect<Input, FullRow, Prepared> {
  /** Validate the side effect against the would-be `input` (the post-save row
   * fields), the raw `body`, and the `existing` full row on update (null on
   * create). Returns `{ error }` to reject the whole write, or `{ value }` with
   * the prepared data to persist once the row exists. */
  validate: (
    input: Input,
    body: Record<string, unknown>,
    existing: FullRow | null,
  ) => Promise<{ error: string } | { value: Prepared }>;
  /** Persist the prepared value on the open write transaction `tx`, given the
   * written row's `id`. A throw rolls back the row write with it. */
  persist: (tx: TxScope, id: number, value: Prepared) => Promise<void>;
}

/** Configuration for defineCrudApi */
export interface CrudApiConfig<
  Row,
  Input,
  FullRow extends Row = Row,
  Prepared = void,
> {
  /** An atomic body-only side effect run around the row write (parents.md Fix 4
   * atomicity). `Prepared` is the value its `validate` carries forward to its
   * `persist`, inferred per resource. See {@link CrudSideEffect}. */
  sideEffect?: CrudSideEffect<Input, FullRow, Prepared>;
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
  /** Side-effect run with the written row's id and the parsed input to persist
   * join-table rows (a listing's groups, a group's package members) that live
   * outside the main table. Runs inside the SAME transaction as the row write
   * (it receives the transaction scope), so a failure rolls the row write back
   * rather than leaving partial state. */
  afterWrite?: (tx: TxScope, id: number, input: Input) => Promise<void>;
  /** Optionally hydrate extra fields onto each response row (list/get/create/
   * update) that don't live on the main table — e.g. a listing's `group_ids`
   * from the join table, so API clients can read back what they POST/PUT. */
  hydrate?: (row: FullRow) => Promise<Record<string, unknown>>;
  /** Optionally hydrate the WHOLE list in one batched call, keyed by row id, so
   * the list endpoint avoids running `hydrate` once per row (an N+1 over the
   * returned rows — costly on remote libsql for large catalogs). When set it is
   * used only by the list endpoint; get/create/update still use `hydrate`. A row
   * absent from the returned map hydrates to no extra fields. */
  hydrateList?: (
    rows: FullRow[],
  ) => Promise<ReadonlyMap<number, Record<string, unknown>>>;
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
  Prepared = void,
>(
  config: CrudApiConfig<Row, Input, FullRow, Prepared>,
): Record<string, RouteHandlerFn> => {
  const { name, singular, table, getAll, nameField, stripKeys = [] } = config;
  const policy = config.policy ?? ADMIN_API;
  const responseKey = singular.toLowerCase();
  const listKey = name;
  const lookup: (id: number) => Promise<FullRow | null> =
    config.lookup ??
    ((id) => table.findById(id) as unknown as Promise<FullRow | null>);

  /** Clean a row for JSON response, hydrating any join-table fields. */
  const toResponse = async (
    row: FullRow,
  ): Promise<Record<string, unknown>> => ({
    ...stripRow(row, stripKeys),
    ...(config.hydrate ? await config.hydrate(row) : {}),
  });

  /** Log create/update, optionally linking to the row's id as listing_id */
  const logAction = (action: string, row: Row): Promise<unknown> =>
    logActivity(
      `${singular} '${row.name}' ${action}`,
      config.linkActivityToRow ? row : undefined,
    );

  /** Build list items, using the batched `hydrateList` when provided (one query
   * for all rows) and falling back to the per-row `hydrate` otherwise. */
  const listItems = async (
    rows: FullRow[],
  ): Promise<Record<string, unknown>[]> => {
    if (!config.hydrateList) return Promise.all(rows.map(toResponse));
    const extraById = await config.hydrateList(rows);
    return rows.map((row) => ({
      ...stripRow(row, stripKeys),
      ...(extraById.get((row as { id: number }).id) ?? {}),
    }));
  };

  /** List all */
  const handleList: RouteHandlerFn = (request) =>
    withAuth(request, policy, async (session) => {
      const rows = await getAll();
      const extras = config.listExtras ? config.listExtras(session) : {};
      return jsonResponse({
        [listKey]: await listItems(rows),
        ...extras,
      });
    });

  /** Log a written full row and return its JSON. */
  const respondWithRow = async (
    fullRow: FullRow,
    action: string,
    status: number,
  ): Promise<Response> => {
    await logAction(action, fullRow);
    return jsonResponse({ [responseKey]: await toResponse(fullRow) }, status);
  };

  /** Write the row and its join-table writes (the prepared side effect and/or
   * `afterWrite`) in ONE transaction, so a failed join write rolls the row write
   * back (no orphan row, no partial membership/override change), then read the
   * committed row back. `existingId` is null on create (the id comes from the
   * INSERT) and the existing id on update. */
  const writeInTransaction = async (
    statement: { args: InValue[]; sql: string },
    existingId: number | null,
    prepared: Prepared,
    input: Input,
  ): Promise<FullRow> => {
    const id = await withTransaction(async (tx) => {
      const res = await tx.execute(statement);
      const rowId = existingId ?? Number(res.lastInsertRowid);
      if (config.sideEffect)
        await config.sideEffect.persist(tx, rowId, prepared);
      if (config.afterWrite) await config.afterWrite(tx, rowId, input);
      return rowId;
    });
    return (await lookup(id))!;
  };

  /** Validate the body-only side effect BEFORE the row write (Fix 4 atomicity):
   * an error short-circuits the whole write (no partial row create/change); a
   * success yields the prepared value to persist once the row exists. Resources
   * without a side effect yield `undefined` and never reject. */
  const prepareSideEffect = async (
    input: Input,
    body: Record<string, unknown>,
    existing: FullRow | null,
  ): Promise<{ error: string } | { value: Prepared }> =>
    config.sideEffect
      ? config.sideEffect.validate(input, body, existing)
      : { value: undefined as Prepared };

  /** Validate the prepared side effect, then write the row. Any join-table write
   * (a side effect and/or `afterWrite`) shares the row write's transaction so a
   * failure rolls the row back rather than leaving partial state; resources with
   * neither use a plain statement. Returns an error response on side-effect
   * rejection, or the logged JSON response on success. */
  const checkAndWrite = async (
    input: Input,
    body: Record<string, unknown>,
    existing: FullRow | null,
    getStatement: () => Promise<{ args: InValue[]; sql: string }>,
    plainWrite: () => Promise<Row>,
    existingId: number | null,
    action: string,
    status: number,
  ): Promise<Response> => {
    const prepared = await prepareSideEffect(input, body, existing);
    if ("error" in prepared) return apiErrorResponse(prepared.error);
    const fullRow =
      config.sideEffect || config.afterWrite
        ? await writeInTransaction(
            await getStatement(),
            existingId,
            prepared.value,
            input,
          )
        : ((await plainWrite()) as unknown as FullRow);
    return respondWithRow(fullRow, action, status);
  };

  /** Validate raw input against config.validate, then invoke fn with the typed
   * result on success; returns the validation error response on failure. */
  const withValidated = async (
    raw: ParseResult<Input> | Promise<ParseResult<Input>>,
    id: number | undefined,
    fn: (input: Input) => Promise<Response>,
  ): Promise<Response> => {
    const result = await parseAndValidate(raw, config.validate, id);
    if (!result.ok) return result.response;
    return fn(result.input);
  };

  /** Create */
  const handleCreate: RouteHandlerFn = (request) =>
    withAuth(request, policy, (_session, body) =>
      withValidated(config.toCreateInput(body), undefined, (input) =>
        checkAndWrite(
          input,
          body,
          null,
          () => table.insertStatement!(input),
          () => table.insert(input),
          null,
          "created",
          201,
        ),
      ),
    );

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
  const handleGet = entityRoute(async (row) =>
    jsonResponse({ [responseKey]: await toResponse(row) }),
  );

  /** Update */
  const handleUpdate = entityRoute((existing, _session, body, id) =>
    withValidated(config.toUpdateInput(body, existing), id, (input) =>
      checkAndWrite(
        input,
        body,
        existing,
        () => table.updateStatement!(existing.id, input),
        () => table.update(existing.id, input) as Promise<Row>,
        existing.id,
        "updated",
        200,
      ),
    ),
  );

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
