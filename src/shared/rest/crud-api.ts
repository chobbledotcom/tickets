/**
 * Generates the five standard admin JSON API routes from one config object,
 * over the existing table definition and validation. The only thing it adds is
 * a JSON body → camelCase input conversion.
 */

/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { logActivity } from "#db/activity-log.ts";
import { byPrimaryKey } from "#db/table-reader.ts";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { type AuthPolicy, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { parseAndValidate, withApiEntity } from "#shared/rest/crud-parsers.ts";
import {
  type JoinWrite,
  refusingCheckTx,
  writeEntity,
} from "#shared/rest/write-entity.ts";
import { writeEntityOrValidationResponse } from "#shared/rest/write-error.ts";
import type { Result } from "#shared/result.ts";
import type { AdminSession } from "#types";

/* jscpd:ignore-end */

import {
  type AdminApiChild,
  type AdminApiCustomRoute,
  type AdminApiResource,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
import type {
  CrudApiConfig,
  CrudApiHandlers,
  CrudChildHandlers,
} from "#shared/rest/crud-api-types.ts";

/** Strip internal keys from a row before sending in the response */
const stripRow = <Row>(row: Row, keys: string[]): Record<string, unknown> => {
  if (keys.length === 0) return row as Record<string, unknown>;
  const result = { ...(row as Record<string, unknown>) };
  for (const key of keys) delete result[key];
  return result;
};

/**
 * Define CRUD API routes for a resource. The resource's path, envelope keys,
 * and id param name come from the admin API resource table. The server cannot
 * disagree with the CLI, the tests, or the docs about them. Generates the
 * five standard verbs plus the child surfaces and the custom routes the table
 * declares for it.
 */

/** The write routes one child surface answers to: the parent's id segment,
 *  then the child's own id for update and delete. The handler record is typed
 *  against the entry's declared child keys with every verb required, so each
 *  child the table declares finds all three handlers. */
const addChildRoutes = (
  routes: Record<string, RouteHandlerFn>,
  name: string,
  paramName: string,
  child: AdminApiChild,
  childApi: CrudChildHandlers,
): void => {
  const base = `/api/admin/${name}/:${paramName}/${child.path}`;
  routes[`POST ${base}`] = childApi.create;
  routes[`PUT ${base}/:${child.idParam}`] = childApi.update;
  routes[`DELETE ${base}/:${child.idParam}`] = childApi.delete;
};

export const defineCrudApi = <
  Entry extends AdminApiResource,
  Row extends { id: number; name: string },
  Input,
  FullRow extends Row = Row,
  Prepared = void,
  State = never,
>(
  entry: Entry,
  config: Omit<
    CrudApiConfig<Row, Input, FullRow, Prepared, State>,
    "name" | "singular"
  > &
    CrudApiHandlers<Entry>,
): Record<string, RouteHandlerFn> => {
  const {
    table,
    getAll,
    nameField,
    stripKeys = [],
    policy,
    deletePolicy = policy,
  } = config;
  const name = entry.path;
  const singular = entry.label;
  const responseKey = singular.toLowerCase();
  const listKey = name;
  const lookup: (id: number) => Promise<FullRow | null> =
    config.lookup === undefined
      ? (id) =>
          table.read.one(
            byPrimaryKey(table, id),
          ) as unknown as Promise<FullRow | null>
      : config.lookup;
  // Reading a row back right after committing its write must hit the primary.
  // A lagging replica can return null, and the create/update path crashes on
  // `.id`. The default is the primary-pinned base-row read. A resource whose
  // `lookup` joins extra columns passes its own primary equivalent.
  const lookupAfterWrite: (id: number) => Promise<FullRow | null> =
    config.lookupAfterWrite === undefined
      ? // Present on every table that reaches the transactional write path (set
        // alongside insertStatement/updateStatement).
        (id) => table.findByIdPrimary!(id) as unknown as Promise<FullRow | null>
      : config.lookupAfterWrite;

  const responseRow = (
    row: FullRow,
    session: AdminSession,
    extraById?: ReadonlyMap<number, Record<string, unknown>>,
  ): Record<string, unknown> => {
    const extra = extraById?.get(row.id);
    const full = {
      ...stripRow(row, stripKeys),
      ...(extra === undefined ? {} : extra),
    };
    return config.projectResponse
      ? config.projectResponse(full, session)
      : full;
  };

  /** Clean one row for a JSON response, hydrating its join-table fields. */
  const toResponse = async (
    row: FullRow,
    session: AdminSession,
  ): Promise<Record<string, unknown>> => {
    const extraById = await config.hydrate?.([row]);
    return responseRow(row, session, extraById);
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
    session: AdminSession,
  ): Promise<Record<string, unknown>[]> => {
    const extraById = await config.hydrate?.(rows);
    return rows.map((row) => responseRow(row, session, extraById));
  };

  /** List all */
  const handleList: RouteHandlerFn = (request) =>
    withAuth(request, policy, async (session) => {
      const rows = await getAll();
      const extras = config.listExtras ? config.listExtras(session) : {};
      return jsonResponse({
        [listKey]: await listItems(rows, session),
        ...extras,
      });
    });

  /** Log a written full row and return its JSON. */
  const respondWithRow = async (
    fullRow: FullRow,
    action: string,
    status: number,
    session: AdminSession,
  ): Promise<Response> => {
    await logAction(action, fullRow);
    return jsonResponse(
      { [responseKey]: await toResponse(fullRow, session) },
      status,
    );
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
    session: AdminSession;
  };

  const prepareSideEffect = async ({ input, body, existing }: WriteInputs) =>
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
    const { input, session } = inputs;
    const prepared = await prepareSideEffect(inputs);
    if ("error" in prepared) return apiErrorResponse(prepared.error);
    const preparedValue = prepared.value;
    const joinWrites: JoinWrite<State>[] = [];
    if (config.sideEffect) {
      joinWrites.push((tx, rowId, state) =>
        config.sideEffect!.persist(tx, rowId, preparedValue, state),
      );
    }
    if (config.afterWrite) {
      joinWrites.push((tx, rowId, state) =>
        config.afterWrite!(tx, rowId, input, state),
      );
    }
    const written = await writeEntityOrValidationResponse(() =>
      writeEntity<FullRow, State>({
        afterCommit: config.afterCommit,
        buildStatement: getStatement,
        checkTx: refusingCheckTx(config.checkTx, input),
        existingId,
        joinWrites,
        plainWrite: () => plainWrite() as unknown as Promise<FullRow | null>,
        readBack: lookupAfterWrite,
        readState: config.readState,
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
    return respondWithRow(fullRow, action, status, session);
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
    withAuth(request, policy, (session, body) =>
      withValidated(
        config.toCreateInput(body, null, session),
        undefined,
        (input) =>
          checkAndWrite(
            { body, existing: null, input, session },
            () => table.insertStatement!(input),
            () => table.insert(input),
            null,
            "created",
            201,
          ),
      ),
    );

  // Build the route param name from the label (e.g. "Holiday" → "holidayId")
  const paramName = adminApiIdParam(singular);

  /** Route handler that extracts the entity ID and loads the full row, delegating to handler */
  const entityRoute = (
    handler: (
      row: FullRow,
      session: AdminSession,
      body: Record<string, unknown>,
      id: number,
    ) => Promise<Response>,
    routePolicy: AuthPolicy<"json"> = policy,
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
        routePolicy,
      );
  };

  /** Get single */
  const handleGet = entityRoute(async (row, session) =>
    jsonResponse({ [responseKey]: await toResponse(row, session) }),
  );

  /** Update */
  const handleUpdate = entityRoute((existing, session, body, id) =>
    withValidated(config.toUpdateInput(body, existing, session), id, (input) =>
      checkAndWrite(
        { body, existing, input, session },
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
  }, deletePolicy);

  /** The extra route entries a resource declares beyond the five standard
   *  verbs: nested child writes, then the server-side custom routes. */
  const declaredRoutes = (): Record<string, RouteHandlerFn> => {
    const routes: Record<string, RouteHandlerFn> = {};
    // The handler records are typed against the entry's declared keys, so
    // every child and custom route the table declares finds its handler; the
    // loops read them back with the key the table declares, and the
    // non-null assertions only restate what CrudApiHandlers proves at each
    // call site.
    for (const [childKey, child] of Object.entries(entry.children ?? {}) as [
      keyof NonNullable<Entry["children"]> & string,
      AdminApiChild,
    ][]) {
      addChildRoutes(
        routes,
        name,
        paramName,
        child,
        config.childHandlers![childKey],
      );
    }
    for (const [customKey, custom] of Object.entries(entry.custom ?? {}) as [
      keyof NonNullable<Entry["custom"]> & string,
      AdminApiCustomRoute,
    ][]) {
      routes[`${custom.method} /api/admin/${name}/${custom.subpath}`] =
        config.customHandlers![customKey];
    }
    return routes;
  };
  return {
    [`GET /api/admin/${name}`]: handleList,
    [`GET /api/admin/${name}/:${paramName}`]: handleGet,
    [`POST /api/admin/${name}`]: handleCreate,
    [`PUT /api/admin/${name}/:${paramName}`]: handleUpdate,
    [`DELETE /api/admin/${name}/:${paramName}`]: handleDelete,
    ...declaredRoutes(),
  };
};
