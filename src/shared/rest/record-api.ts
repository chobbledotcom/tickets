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
import { type AuthPolicy, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  type AdminApiChild,
  type AdminApiResource,
  adminApiIdParam,
} from "#shared/admin-api-resources.ts";
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
  jsonAudienceFor,
  type RecordSurface,
  type WritePlan,
} from "#shared/rest/record.ts";
import type { Result } from "#shared/result.ts";
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

/** The record's own API config: the two body mappers and the response
 * presentation. Everything about the write lives on the record. */
export type RecordApiConfig<
  Entry extends AdminApiResource,
  Row extends { id: number },
  Input,
  FullRow extends Row,
  Prepared = void,
  State = never,
> = CrudApiHandlers<Entry> & {
  toCreateInput: WriteMapper<Input, WriteBody<Entry["createBodySchema"]>, null>;
  toUpdateInput: WriteMapper<
    Input,
    WriteBody<Entry["updateBodySchema"]>,
    FullRow
  >;
  /** A side effect run around the row write: its `validate` runs before the
   * write, its `persist` inside it. */
  sideEffect?: CrudSideEffect<Input, FullRow, Prepared, State>;
  hydrate?: (rows: FullRow[]) => Promise<HydratedRows>;
  hydrateAfterWrite?: (rows: FullRow[]) => Promise<HydratedRows>;
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

const stripRow = <Row>(row: Row, keys: string[]): Record<string, unknown> => {
  if (keys.length === 0) return row as Record<string, unknown>;
  const stripped = { ...(row as Record<string, unknown>) };
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

/**
 * Build the JSON API routes for one record.
 */
export const recordApi = <
  Entry extends AdminApiResource,
  Row extends { id: number },
  Input,
  FullRow extends Row = Row,
  Prepared = void,
  State = never,
>(
  record: AdminRecord<Row, Input, FullRow, State>,
  config: RecordApiConfig<Entry, Row, Input, FullRow, Prepared, State>,
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
  const lookup = record.load;
  const stripKeys = config.stripKeys ?? [];

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

  const toResponse = async (
    row: FullRow,
    session: AdminSession,
    hydrate = config.hydrate,
  ): Promise<Record<string, unknown>> => {
    const extraById = await hydrate?.([row]);
    return responseRow(row, session, extraById);
  };

  const listItems = async (
    rows: FullRow[],
    session: AdminSession,
  ): Promise<Record<string, unknown>[]> => {
    const extraById = await config.hydrate?.(rows);
    return rows.map((row) => responseRow(row, session, extraById));
  };

  const handleList: RouteHandlerFn = (request) =>
    withAuth(request, readPolicy, async (session) => {
      const rows = await record.getAll();
      const extras = config.listExtras ? config.listExtras(session) : {};
      return jsonResponse({
        [name]: await listItems(rows, session),
        ...extras,
      });
    });

  const respondWithRow = async (
    row: FullRow,
    status: number,
    session: AdminSession,
  ): Promise<Response> =>
    jsonResponse(
      {
        [responseKey]: await toResponse(row, session, config.hydrateAfterWrite),
      },
      status,
    );

  /** The per-call plan a record write runs: the side effect's validation
   * before the row statement and its write inside the transaction. */
  const writePlan = (
    body: Record<string, unknown>,
    existing: FullRow | null,
  ): WritePlan<Prepared, State> | undefined =>
    config.sideEffect
      ? {
          persist: (tx, id, value, state) =>
            config.sideEffect!.persist(tx, id, value, state),
          prepare: (input) =>
            config.sideEffect!.validate(
              input as Input,
              body,
              existing,
            ) as Promise<{ error: string } | { value: Prepared }>,
        }
      : undefined;

  /** The write input: the entry's schema validates the raw body, then the
   *  record's mapper produces the input. */
  const writeInput = (
    body: Record<string, unknown>,
    existing: FullRow | null,
    session: AdminSession,
  ): Result<Input> | Promise<Result<Input>> => {
    const schema =
      existing === null ? entry.createBodySchema : entry.updateBodySchema;
    const parsed: Result<unknown> =
      schema === undefined
        ? { ok: true, value: body }
        : parseApiBody(schema, body);
    if (!parsed.ok) return parsed;
    return existing === null
      ? config.toCreateInput(
          parsed.value as WriteBody<Entry["createBodySchema"]>,
          null,
          session,
        )
      : config.toUpdateInput(
          parsed.value as WriteBody<Entry["updateBodySchema"]>,
          existing,
          session,
        );
  };

  const validatedInput = async (
    raw: Result<Input> | Promise<Result<Input>>,
  ): Promise<{ response: Response } | { input: Input }> => {
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

  const handleCreate: RouteHandlerFn = (request) =>
    withAuth(request, readPolicy, async (session, body) => {
      const validated = await validatedInput(writeInput(body, null, session));
      if ("response" in validated) return validated.response;
      const verdict = await record.create(
        validated.input,
        writePlan(body, null),
      );
      if (verdict.kind !== "written") return failureResponse(verdict);
      return respondWithRow(verdict.row, 201, session);
    });

  const paramName = adminApiIdParam(singular);

  const entityRoute = (
    handler: (
      row: FullRow,
      session: AdminSession,
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

  const handleUpdate = entityRoute(async (existing, session, body, id) => {
    const validated = await validatedInput(writeInput(body, existing, session));
    if ("response" in validated) return validated.response;
    const verdict = await record.update(
      id,
      validated.input,
      writePlan(body, existing),
    );
    if (verdict.kind !== "written") return failureResponse(verdict);
    return respondWithRow(verdict.row, 200, session);
  });

  const handleDelete = entityRoute(async (existing, _session, body, id) => {
    const error = verifyIdentifierOrJsonError(
      String(existing[nameField]),
      body.confirm_identifier,
      `${singular} name`,
    );
    if (error) return apiErrorResponse(error);
    const verdict = await record.remove(id);
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

  const standard = {
    create: handleCreate,
    delete: handleDelete,
    get: handleGet,
    list: handleList,
    update: handleUpdate,
  };
  const routes = config.overrides ?? {};

  return {
    [`GET /api/admin/${name}`]: routes.list ?? standard.list,
    [`GET /api/admin/${name}/:${paramName}`]: routes.get ?? standard.get,
    [`POST /api/admin/${name}`]: routes.create ?? standard.create,
    [`PUT /api/admin/${name}/:${paramName}`]: routes.update ?? standard.update,
    [`DELETE /api/admin/${name}/:${paramName}`]:
      routes.delete ?? standard.delete,
    ...declaredRoutes(),
  };
};
