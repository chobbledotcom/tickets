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
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { logActivity } from "#shared/db/activity-log.ts";
import { byPrimaryKey } from "#shared/db/table-reader.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { parseAndValidate, withApiEntity } from "#shared/rest/crud-parsers.ts";
import { type JoinWrite, writeEntity } from "#shared/rest/write-entity.ts";
import { writeEntityOrValidationResponse } from "#shared/rest/write-error.ts";
import type { Result } from "#shared/result.ts";
import type { AdminSession } from "#shared/types.ts";

/* jscpd:ignore-end */

export type {
  AfterCommitConfig,
  AfterWriteHook,
  CrudApiConfig,
  CrudSideEffect,
} from "#shared/rest/crud-api-types.ts";

import type { CrudApiConfig } from "#shared/rest/crud-api-types.ts";

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
    ((id) =>
      table.read.one(
        byPrimaryKey(table, id),
      ) as unknown as Promise<FullRow | null>);
  // Reading a row back right after committing its write must hit the primary, or
  // a lagging replica can return null and the create/update path crashes on
  // `.id`. Defaults to the primary-pinned base-row read; a resource whose
  // `lookup` joins extra columns passes its own primary equivalent.
  const lookupAfterWrite: (id: number) => Promise<FullRow | null> =
    config.lookupAfterWrite ??
    // Present on every table that reaches the transactional write path (set
    // alongside insertStatement/updateStatement).
    ((id) => table.findByIdPrimary!(id) as unknown as Promise<FullRow | null>);

  const responseRow = (
    row: FullRow,
    extraById?: ReadonlyMap<number, Record<string, unknown>>,
  ): Record<string, unknown> => ({
    ...stripRow(row, stripKeys),
    ...(extraById?.get(row.id) ?? {}),
  });

  /** Clean one row for a JSON response, hydrating its join-table fields. */
  const toResponse = async (row: FullRow): Promise<Record<string, unknown>> => {
    const extraById = await config.hydrate?.([row]);
    return responseRow(row, extraById);
  };

  /** Log create/update, optionally linking to the row's id as listing_id */
  const logAction = (action: string, row: Row): Promise<unknown> =>
    logActivity(
      `${singular} '${row.name}' ${action}`,
      config.linkActivityToRow ? row : undefined,
    );

  /** Build list items with one batched hydration call. */
  const listItems = async (
    rows: FullRow[],
  ): Promise<Record<string, unknown>[]> => {
    const extraById = await config.hydrate?.(rows);
    return rows.map((row) => responseRow(row, extraById));
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
      joinWrites.push((tx, rowId) =>
        config.afterWrite!(tx, rowId, input, inputs.existing),
      );
    }
    const written = await writeEntityOrValidationResponse(() =>
      writeEntity<FullRow>({
        afterCommit: config.afterCommit,
        buildStatement: getStatement,
        existingId,
        joinWrites,
        plainWrite: () => plainWrite() as unknown as Promise<FullRow | null>,
        readBack: lookupAfterWrite,
        tableName: config.table.name,
      }),
    );
    if ("response" in written) return written.response;
    const fullRow = written.row;
    // writeEntity returns null only for an update whose row was deleted between
    // the entityRoute lookup and the commit. Report a clean not-found (as
    // defineResource's update path does) rather than dereferencing null in
    // respondWithRow.
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
