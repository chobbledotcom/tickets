/**
 * Generic CRUD API factory — generates JSON API routes for simple resources.
 *
 * Reuses existing table definitions and validation, adding a thin JSON
 * body → camelCase input conversion layer on top.
 *
 * Usage:
 *   const routes = defineCrudApi({
 *     name: "holidays",
 *     table: holidays.table,
 *     getAll: holidays.getAll,
 *     fields: [...],
 *     toInput: (body) => ({ ... }),
 *     toUpdateInput: (body, existing) => ({ ... }),
 *     validate: (input) => ...,
 *     nameField: "name",
 *   });
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { reduce } from "#fp";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, type AuthPolicy, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { TxScope } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { type JoinWrite, writeEntity } from "#shared/rest/write-entity.ts";
import {
  errorResult,
  okResult,
  parseOptionalResult,
  type Result,
} from "#shared/result.ts";
import type { AdminSession } from "#shared/types.ts";
/* jscpd:ignore-end */

/** JSON body for confirmed delete endpoints */
export type DeleteBody = { confirm_identifier: string };

/**
 * Parse a required non-empty string field from a JSON body.
 * Returns the trimmed string or null if missing/empty. Internal helper for
 * {@link requireStrings}.
 */
const requireString = (
  body: Record<string, unknown>,
  key: string,
): string | null =>
  typeof body[key] === "string" && body[key].trim() !== ""
    ? body[key].trim()
    : null;

/** Parse every item with one shared first-error traversal. */
const parseEach =
  <Input, Output>(parseItem: (item: Input) => Result<Output>) =>
  (items: readonly Input[]): Result<Output[]> =>
    reduce((result: Result<Output[]>, item: Input): Result<Output[]> => {
      if (!result.ok) return result;
      const parsed = parseItem(item);
      if (!parsed.ok) return parsed;
      result.value.push(parsed.value);
      return result;
    }, okResult<Output[]>([]))([...items]);

/**
 * Read several required non-empty string fields from a JSON body in one call.
 * Returns the trimmed values keyed by field name, or a ready `{ ok: false }`
 * rejection naming the first missing/empty field. Lets a create parser require
 * all its mandatory fields at once instead of repeating a `requireString` +
 * "<field> is required" pair per field (which the 0% duplication check flags as
 * a cross-file clone).
 */
export const requireStrings = <K extends string>(
  body: Record<string, unknown>,
  keys: readonly K[],
): Result<Record<K, string>> => {
  const parsed = parseEach((key: K): Result<readonly [K, string]> => {
    const value = requireString(body, key);
    return value
      ? okResult([key, value] as const)
      : errorResult(`${key} is required`);
  })(keys);
  return parsed.ok
    ? okResult(Object.fromEntries(parsed.value) as Record<K, string>)
    : parsed;
};

/**
 * Read an optional typed scalar from a JSON body, falling back to `fallback`
 * when the key is absent or holds the wrong type. The create/update parsers use
 * these instead of repeating `typeof body[key] === "…" ? body[key] : fallback`
 * for every field, so a malformed value is consistently ignored (create →
 * default, update → keep existing) rather than coerced.
 */
export const bodyString = (
  body: Record<string, unknown>,
  key: string,
  fallback: string,
): string => (typeof body[key] === "string" ? body[key] : fallback);

export const bodyNumber = (
  body: Record<string, unknown>,
  key: string,
  fallback: number,
): number => (typeof body[key] === "number" ? body[key] : fallback);

export const bodyBoolean = (
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean => (typeof body[key] === "boolean" ? body[key] : fallback);

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
  parseItem: (item: unknown) => Result<T>,
): Result<T[] | undefined> =>
  parseOptionalResult(raw, (value) => {
    if (!Array.isArray(value)) {
      return errorResult(`${label} must be an array`);
    }
    return parseEach(parseItem)(value);
  });

/** Result of parsing + validating: either the input or a pre-built error response */
export type ValidatedInput<Input> =
  | { ok: true; input: Input }
  | { ok: false; response: Response };

/**
 * Parse + validate a JSON body into a typed input, returning a ready-to-return
 * error response on failure. Used by route handlers to short-circuit on error.
 */
export const parseAndValidate = async <Input>(
  parsed: Result<Input> | Promise<Result<Input>>,
  validate?: (input: Input, id?: number) => Promise<string | null>,
  id?: number,
): Promise<ValidatedInput<Input>> => {
  const result = await parsed;
  if (!result.ok) {
    return { ok: false, response: apiErrorResponse(result.error) };
  }
  if (validate) {
    const error = await validate(result.value, id);
    if (error) return { ok: false, response: apiErrorResponse(error) };
  }
  return { input: result.value, ok: true };
};

/**
 * Parse an optional slug field from a JSON body for update operations.
 * Returns the normalized slug and computed index, falling back to the existing slug.
 */
export const parseUpdateSlug = async <Index extends string>(
  body: Record<string, unknown>,
  existing: string,
  normalize: (slug: string) => string,
  computeIndex: (slug: string) => Promise<Index>,
): Promise<{ slug: string; slugIndex: Index }> => {
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
): Result<string> => {
  const name = body.name != null ? String(body.name).trim() : existing;
  return name === "" ? errorResult("name cannot be empty") : okResult(name);
};

/**
 * An atomic body-only side effect (e.g. relationship edges) for a create/update.
 * Two-phase so the whole write is all-or-nothing:
 * `validate` runs BEFORE the write and either rejects (400, nothing written) or
 * yields a prepared `value`; `persist` then runs in the SAME transaction as the
 * row write (see `writeWithSideEffect`), so a failure rolls the row write back
 * too — never an orphan row without its side effect. A resource with no side
 * effects omits it and takes the plain (untransacted) single-statement path.
 */
export interface CrudSideEffect<Input, FullRow, Prepared> {
  /** Persist the prepared value on the open write transaction `tx`, given the
   * written row's `id`. A throw rolls back the row write with it. */
  persist: (tx: TxScope, id: number, value: Prepared) => Promise<void>;
  /** Validate the side effect against the would-be `input` (the post-save row
   * fields), the raw `body`, and the `existing` full row on update (null on
   * create). Returns `{ error }` to reject the whole write, or `{ value }` with
   * the prepared data to persist once the row exists. */
  validate: (
    input: Input,
    body: Record<string, unknown>,
    existing: FullRow | null,
  ) => Promise<{ error: string } | { value: Prepared }>;
}

/** The post-commit hook shared by every write-config: it runs after a
 * create/update has committed and the row has been re-read, keyed on the row
 * id. Unlike `afterWrite` (which shares the write transaction), this fires
 * post-commit — for reconciling a derived table (e.g. listing_prices) that the
 * transactional `insertStatement`/`updateStatement` path would otherwise
 * bypass. */
export interface AfterCommitConfig {
  afterCommit?: (id: number) => Promise<void>;
}

/** A join-table write run inside the row's write transaction, given the open
 * transaction scope, the written row's id, and the parsed input. */
export type AfterWriteHook<Input> = (
  tx: TxScope,
  id: number,
  input: Input,
) => Promise<void>;

/** Configuration for defineCrudApi */
export interface CrudApiConfig<
  Row,
  Input,
  FullRow extends Row = Row,
  Prepared = void,
> extends AfterCommitConfig {
  /** Side-effect run with the written row's id and the parsed input to persist
   * join-table rows (a listing's groups, a group's package members) that live
   * outside the main table. Runs inside the SAME transaction as the row write
   * (it receives the transaction scope), so a failure rolls the row write back
   * rather than leaving partial state. */
  afterWrite?: AfterWriteHook<Input>;
  /** Extra route entries to merge in (can also override generated routes) */
  extraRoutes?: Record<string, RouteHandlerFn>;
  /** Fetch all rows (from cache) — may return a richer row type than the table (e.g. joined counts) */
  getAll: () => Promise<FullRow[]>;
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
  /** When true, activity log entries for create/update are linked to the row's id as listing_id */
  linkActivityToRow?: boolean;
  /** Extra keys added to the list response alongside the row array (e.g. admin_level) */
  listExtras?: (session: AdminSession) => Record<string, unknown>;
  /** Custom single-row lookup (e.g. to include joined counts). Defaults to table.findById. */
  lookup?: (id: number) => Promise<FullRow | null>;
  /** Custom single-row lookup used ONLY to read a row back right after committing
   * its own write, which must be pinned to the primary (read-your-writes): the
   * default `lookup` runs in "read" mode and can hit a replica that lags the
   * commit, returning null for the just-written row and crashing on `.id`.
   * Defaults to `table.findByIdPrimary`; a resource whose `lookup` joins extra
   * columns (e.g. listings' counts) must pass a primary-pinned equivalent so the
   * write response still carries those columns. */
  lookupAfterWrite?: (id: number) => Promise<FullRow | null>;
  /** Resource name (lowercase plural, used in routes and log messages) */
  name: string;
  /** Field on Row that holds the display name (for delete confirmation) */
  nameField: keyof FullRow & string;
  /** Custom delete logic (e.g. cascade). If not provided, uses table.deleteById */
  onDelete?: (id: InValue) => Promise<void>;
  /** Auth policy for all generated routes. Defaults to ADMIN_API (any admin);
   * pass OWNER_API for resources whose web management is owner-only. */
  policy?: AuthPolicy<"json">;
  /** An atomic body-only side effect run around the row write. `Prepared` is
   * the value its `validate` carries forward to its
   * `persist`, inferred per resource. See {@link CrudSideEffect}. */
  sideEffect?: CrudSideEffect<Input, FullRow, Prepared>;
  /** Singular display name for activity log (e.g. "Holiday") */
  singular: string;
  /** Keys to strip from response (e.g. "slug_index") */
  stripKeys?: string[];
  /** Table with CRUD operations */
  table: Table<Row, Input>;
  /** Convert JSON body to Input for create */
  toCreateInput: (
    body: Record<string, unknown>,
  ) => Result<Input> | Promise<Result<Input>>;
  /** Convert JSON body + existing row to Input for update */
  toUpdateInput: (
    body: Record<string, unknown>,
    existing: FullRow,
  ) => Result<Input> | Promise<Result<Input>>;
  /** Optional validation (return error message or null) */
  validate?: (input: Input, id?: number) => Promise<string | null>;
  /** Optional delete guard: a returned message blocks the deletion with a 400
   * (e.g. a sold hidden package whose tickets still resolve through it). */
  validateDelete?: (id: number) => Promise<string | null>;
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
  // Reading a row back right after committing its write must hit the primary, or
  // a lagging replica can return null and the create/update path crashes on
  // `.id`. Defaults to the primary-pinned base-row read; a resource whose
  // `lookup` joins extra columns passes its own primary equivalent.
  const lookupAfterWrite: (id: number) => Promise<FullRow | null> =
    config.lookupAfterWrite ??
    // Present on every table that reaches the transactional write path (set
    // alongside insertStatement/updateStatement).
    ((id) => table.findByIdPrimary!(id) as unknown as Promise<FullRow | null>);

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

  /** Validate the body-only side effect BEFORE the row write (atomicity):
   * an error short-circuits the whole write (no partial row create/change); a
   * success yields the prepared value to persist once the row exists. Resources
   * without a side effect yield `undefined` and never reject. */
  // The shared inputs every write step reads: the typed input, the raw body,
  // and the existing row (null when creating).
  type WriteInputs = {
    input: Input;
    body: Record<string, unknown>;
    existing: FullRow | null;
  };

  const prepareSideEffect = async ({
    input,
    body,
    existing,
  }: WriteInputs): Promise<{ error: string } | { value: Prepared }> =>
    config.sideEffect
      ? config.sideEffect.validate(input, body, existing)
      : { value: undefined as Prepared };

  /** Validate the prepared side effect, then write the row. Any join-table write
   * (a side effect and/or `afterWrite`) shares the row write's transaction so a
   * failure rolls the row back rather than leaving partial state; resources with
   * neither use a plain statement. Returns an error response on side-effect
   * rejection, or the logged JSON response on success. */
  const checkAndWrite = async (
    inputs: WriteInputs,
    getStatement: () => Promise<{ args: InValue[]; sql: string }>,
    plainWrite: () => Promise<Row>,
    existingId: number | null,
    action: string,
    status: number,
  ): Promise<Response> => {
    const { input } = inputs;
    const prepared = await prepareSideEffect(inputs);
    if ("error" in prepared) return apiErrorResponse(prepared.error);
    const preparedValue = prepared.value;
    const joinWrites: JoinWrite[] = [];
    if (config.sideEffect) {
      joinWrites.push((tx, rowId) =>
        config.sideEffect!.persist(tx, rowId, preparedValue),
      );
    }
    if (config.afterWrite) {
      joinWrites.push((tx, rowId) => config.afterWrite!(tx, rowId, input));
    }
    const fullRow = await writeEntity<FullRow>({
      afterCommit: config.afterCommit,
      buildStatement: getStatement,
      existingId,
      joinWrites,
      plainWrite: () => plainWrite() as unknown as Promise<FullRow | null>,
      readBack: lookupAfterWrite,
    });
    // writeEntity returns null when the just-written row can't be read back —
    // an update whose row was deleted between the entityRoute lookup and the
    // commit. Report a clean not-found (as defineResource's update path does)
    // rather than dereferencing null in respondWithRow.
    if (!fullRow) return apiErrorResponse(`${singular} not found`, 404);
    return respondWithRow(fullRow, action, status);
  };

  /** Validate raw input against config.validate, then invoke fn with the typed
   * result on success; returns the validation error response on failure. */
  const withValidated = async (
    raw: Result<Input> | Promise<Result<Input>>,
    id: number | undefined,
    fn: ResponseHandler<[value: Input]>,
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
          { body, existing: null, input },
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
        { body, existing, input },
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

    const deleteError = config.validateDelete
      ? await config.validateDelete(Number(existing.id))
      : null;
    if (deleteError) return apiErrorResponse(deleteError);

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
