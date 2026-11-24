/**
 * The JSON API routes for one admin record. They are the five standard verbs,
 * the nested child surfaces, and the server-side custom routes, all over the
 * record's single write path.
 *
 * Every audience comes from the admin surface declaration of the record's page
 * routes. A record module never names a JSON policy.
 */

import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { type AuthPolicy, type AuthSession, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  type AdminApiChild,
  type AdminApiResource,
  type AdminApiServes,
  adminApiIdParam,
  adminApiServes,
} from "#shared/admin-api-resources.ts";
import { snakeCaseKeys } from "#shared/column-names.ts";
import type {
  CrudApiHandlers,
  CrudChildHandlers,
  CrudSideEffect,
  HydratedRows,
  WriteBody,
  WriteMapper,
} from "#shared/rest/crud-api-types.ts";
import {
  parseAndValidate,
  parseApiBody,
  withApiEntity,
} from "#shared/rest/crud-parsers.ts";
import {
  type AdminRecord,
  deleteAudienceFor,
  type FullRowOf,
  type GetAllCommand,
  type InputOf,
  jsonAudienceFor,
  type RecordShape,
  type RecordSurface,
  type StateOf,
  type WritePlan,
  type WriteVerdict,
} from "#shared/rest/record.ts";
import { gatedByFeature } from "#shared/rest/resource-feature.ts";
import type { AsyncResult, Result } from "#shared/result.ts";
import type { AdminLevel, AdminSession } from "#types";

/** The five standard routes a record's JSON surface serves. An override
 * replaces the generated handler for that verb. */
export type RecordApiOverrides = {
  create?: RouteHandlerFn;
  delete?: RouteHandlerFn;
  get?: RouteHandlerFn;
  list?: RouteHandlerFn;
  update?: RouteHandlerFn;
};

export type RecordApiConfig<
  Entry extends AdminApiResource,
  Shape extends RecordShape,
  Prepared = void,
> = CrudApiHandlers<Entry> & {
  toCreateInput: WriteMapper<
    InputOf<Shape>,
    WriteBody<Entry["createBodySchema"]>,
    null
  >;
  /** Absent for a record that no body edits. It then serves no update route. */
  toUpdateInput?: WriteMapper<
    InputOf<Shape>,
    WriteBody<Entry["updateBodySchema"]>,
    FullRowOf<Shape>
  >;
  /** A side effect run around the row write: its `validate` runs before the
   * write, its `persist` inside it. */
  sideEffect?: CrudSideEffect<
    InputOf<Shape>,
    FullRowOf<Shape>,
    Prepared,
    StateOf<Shape>
  >;
  hydrate?: (rows: FullRowOf<Shape>[]) => Promise<HydratedRows>;
  hydrateAfterWrite?: (rows: FullRowOf<Shape>[]) => Promise<HydratedRows>;
  listExtras?: (session: AdminSession) => Record<string, unknown>;
  stripKeys?: string[];
  projectResponse?: (
    row: Record<string, unknown>,
    session: AdminSession,
  ) => Record<string, unknown>;
  overrides?: RecordApiOverrides;
};

/** A JSON policy from one surface audience: an API key or a cookie session,
 * and exactly the roles the page declares. */
const jsonPolicy = (audience: readonly AdminLevel[]): AuthPolicy<"json"> => ({
  allowApiKey: true,
  body: "json",
  roles: audience,
});

/** The JSON policy a record's page route declares. A child surface reads it
 * so a nested read or write answers the roles its parent page admits. */
export const recordJsonPolicy = (record: RecordSurface): AuthPolicy<"json"> =>
  jsonPolicy(jsonAudienceFor(record.list));

/** The JSON policy of a record's delete page, for a custom delete route that
 * names its own audience. */
export const recordJsonDeletePolicy = (
  record: RecordSurface,
): AuthPolicy<"json"> => jsonPolicy(deleteAudienceFor(record));

/** The row as the JSON API sends it: under its column names, without the
 *  keys that the resource keeps private. */
const stripRow = (row: object, keys: string[]): Record<string, unknown> => {
  const stripped: Record<string, unknown> = snakeCaseKeys(row);
  for (const key of keys) delete stripped[key];
  return stripped;
};

/** The records a resource declares for one kind of route, keyed the way the
 * table declares them. */
const declaredRecords = <Records>(
  records: Partial<Records> | undefined,
): [keyof Records & string, Records[keyof Records]][] =>
  Object.entries(records ?? {}) as [
    keyof Records & string,
    Records[keyof Records],
  ][];

/** Add one declared child surface's three routes. */
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

/** The five standard JSON handlers, keyed the way the route table expects. */
type ApiHandlerSet = {
  create: RouteHandlerFn;
  delete: RouteHandlerFn;
  get: RouteHandlerFn;
  list: RouteHandlerFn;
  update: RouteHandlerFn;
};

/** Build one API handler set from its five handlers. */
export const apiHandlerSet = (
  create: RouteHandlerFn,
  remove: RouteHandlerFn,
  get: RouteHandlerFn,
  list: RouteHandlerFn,
  update: RouteHandlerFn,
): ApiHandlerSet => ({ create, delete: remove, get, list, update });

/** The API lists full rows: a record whose page list reads a narrower summary
 * gives the API its full read. */
type ApiRecord<Shape extends RecordShape> = Omit<
  AdminRecord<Shape>,
  "getAll"
> & {
  getAll: GetAllCommand<FullRowOf<Shape>>;
};

/**
 * Build the JSON API routes for one record.
 */
export const recordApi = <
  Entry extends AdminApiResource,
  Shape extends RecordShape,
  Prepared = void,
>(
  record: ApiRecord<Shape>,
  config: RecordApiConfig<Entry, Shape, Prepared>,
): Record<string, RouteHandlerFn> => {
  const entry = record.api;
  if (!entry) {
    throw new Error(`The record for ${record.list} declares no JSON resource`);
  }
  const name = entry.path;
  const singular = entry.label;
  const responseKey = singular.toLowerCase();
  const readPolicy = jsonPolicy(jsonAudienceFor(record.list));
  const deletePolicy = jsonPolicy(deleteAudienceFor(record));
  const nameField = record.nameField;
  if (nameField === undefined) {
    throw new Error(`The ${singular} record names no display-name column`);
  }
  const lookup = (id: number, session: AuthSession) =>
    record.load(id, { session });
  const stripKeys = config.stripKeys ?? [];

  const responseRow = (
    row: FullRowOf<Shape>,
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

  const toResponse = async (
    row: FullRowOf<Shape>,
    session: AdminSession,
    hydrate = config.hydrate,
  ): Promise<Record<string, unknown>> => {
    const extraById = await hydrate?.([row]);
    return responseRow(row, session, extraById);
  };

  const listItems = async (
    rows: FullRowOf<Shape>[],
    session: AdminSession,
  ): Promise<Record<string, unknown>[]> => {
    const extraById = await config.hydrate?.(rows);
    return rows.map((row) => responseRow(row, session, extraById));
  };

  const handleList: RouteHandlerFn = (request) =>
    withAuth(request, readPolicy, async (session) => {
      const rows = await record.getAll({ session });
      const extras = config.listExtras ? config.listExtras(session) : {};
      return jsonResponse({
        [name]: await listItems(rows, session),
        ...extras,
      });
    });

  const respondWithRow = async (
    row: FullRowOf<Shape>,
    status: number,
    session: AdminSession,
  ): Promise<Response> =>
    jsonResponse(
      {
        [responseKey]: await toResponse(row, session, config.hydrateAfterWrite),
      },
      status,
    );

  /** One submitted JSON body and the row it updates, or null on create. */
  type SubmittedRow = {
    body: Record<string, unknown>;
    existing: FullRowOf<Shape> | null;
  };

  /** The per-call plan a record write runs: the side effect's validation
   * before the row statement and its write inside the transaction. */
  const writePlan = ({
    body,
    existing,
  }: SubmittedRow): WritePlan<Prepared, StateOf<Shape>> | undefined =>
    config.sideEffect
      ? {
          persist: (tx, id, value, state) =>
            config.sideEffect!.persist(tx, id, value, state),
          prepare: (input) =>
            config.sideEffect!.validate(
              input as InputOf<Shape>,
              body,
              existing,
            ) as Promise<{ error: string } | { value: Prepared }>,
        }
      : undefined;

  /** The write input of one body: the schema validates the raw body, then the
   *  record's mapper produces the input. An entry with no schema keeps the
   *  body as sent. */
  const inputOf = (
    schema: AdminApiResource["createBodySchema"],
    body: Record<string, unknown>,
    toInput: (parsed: unknown) => AsyncResult<InputOf<Shape>>,
  ): AsyncResult<InputOf<Shape>> => {
    const parsed: Result<unknown> =
      schema === undefined
        ? { ok: true, value: body }
        : parseApiBody(schema, body);
    return parsed.ok ? toInput(parsed.value) : parsed;
  };

  const validatedInput = async (
    raw: AsyncResult<InputOf<Shape>>,
  ): Promise<{ response: Response } | { input: InputOf<Shape> }> => {
    const result = await parseAndValidate(raw);
    if (!result.ok) return { response: result.response };
    return { input: result.input };
  };

  /** The answer a refused or vanished write gives. */
  const failureResponse = (
    verdict: { kind: "refused"; message: string } | { kind: "not-found" },
  ): Response =>
    verdict.kind === "refused"
      ? apiErrorResponse(verdict.message)
      : apiErrorResponse(`${singular} not found`, 404);

  /** Validate one write input, run the write, and answer its verdict. */
  const runValidatedWrite = async (
    raw: AsyncResult<InputOf<Shape>>,
    write: (input: InputOf<Shape>) => Promise<WriteVerdict<FullRowOf<Shape>>>,
    status: number,
    session: AuthSession,
  ): Promise<Response> => {
    const validated = await validatedInput(raw);
    if ("response" in validated) return validated.response;
    const verdict = await write(validated.input);
    return verdict.kind === "written"
      ? respondWithRow(verdict.row, status, session)
      : failureResponse(verdict);
  };

  const handleCreate: RouteHandlerFn = (request) =>
    withAuth(request, readPolicy, (session, body) =>
      runValidatedWrite(
        inputOf(entry.createBodySchema, body, (parsed) =>
          config.toCreateInput(
            parsed as WriteBody<Entry["createBodySchema"]>,
            null,
            session,
          ),
        ),
        (input) =>
          record.create(input, writePlan({ body, existing: null }), {
            session,
          }),
        201,
        session,
      ),
    );

  const paramName = adminApiIdParam(singular);

  const entityRoute = (
    handler: (
      row: FullRowOf<Shape>,
      session: AuthSession,
      body: Record<string, unknown>,
      id: number,
    ) => Promise<Response>,
    routePolicy: AuthPolicy<"json"> = readPolicy,
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
        (row, session, body) => handler(row, session, body, getId(params)),
        routePolicy,
      );
  };

  const handleGet = entityRoute(async (row, session) =>
    jsonResponse({ [responseKey]: await toResponse(row, session) }),
  );

  const handleUpdate = (
    toUpdateInput: NonNullable<typeof config.toUpdateInput>,
  ) =>
    entityRoute((existing, session, body, id) =>
      runValidatedWrite(
        inputOf(entry.updateBodySchema, body, (parsed) =>
          toUpdateInput(
            parsed as WriteBody<Entry["updateBodySchema"]>,
            existing,
            session,
          ),
        ),
        (input) =>
          record.update(id, input, writePlan({ body, existing }), { session }),
        200,
        session,
      ),
    );

  const handleDelete = entityRoute(async (existing, session, body, id) => {
    const error = verifyIdentifierOrJsonError(
      String(existing[nameField]),
      body.confirm_identifier,
      `${singular} name`,
    );
    if (error) return apiErrorResponse(error);
    const verdict = await record.remove(id, undefined, { session });
    if (verdict.kind !== "deleted") return failureResponse(verdict);
    return jsonResponse({ status: "ok" });
  }, deletePolicy);

  const declaredRoutes = (): Record<string, RouteHandlerFn> => {
    const routes: Record<string, RouteHandlerFn> = {};
    const children = declaredRecords<NonNullable<Entry["children"]>>(
      entry.children,
    );
    for (const [childKey, child] of children) {
      addChildRoutes(
        routes,
        name,
        paramName,
        child,
        config.childHandlers![childKey],
      );
    }
    const customRoutes = declaredRecords<NonNullable<Entry["custom"]>>(
      entry.custom,
    );
    for (const [customKey, custom] of customRoutes) {
      routes[`${custom.method} /api/admin/${name}/${custom.subpath}`] =
        config.customHandlers![customKey];
    }
    return routes;
  };

  const routes = config.overrides ?? {};
  // A record that no body edits gives no update mapper, so it has no handler.
  const updateHandler =
    routes.update ??
    (config.toUpdateInput === undefined
      ? undefined
      : handleUpdate(config.toUpdateInput));
  const standard: [keyof AdminApiServes, string, RouteHandlerFn | undefined][] =
    [
      ["list", `GET /api/admin/${name}`, routes.list ?? handleList],
      ["get", `GET /api/admin/${name}/:${paramName}`, routes.get ?? handleGet],
      ["create", `POST /api/admin/${name}`, routes.create ?? handleCreate],
      ["update", `PUT /api/admin/${name}/:${paramName}`, updateHandler],
      [
        "delete",
        `DELETE /api/admin/${name}/:${paramName}`,
        routes.delete ?? handleDelete,
      ],
    ];

  return gatedByFeature(entry, {
    ...Object.fromEntries(
      standard.flatMap(([verb, route, handler]) =>
        handler !== undefined && adminApiServes(entry, verb)
          ? [[route, handler] as const]
          : [],
      ),
    ),
    ...declaredRoutes(),
  });
};
