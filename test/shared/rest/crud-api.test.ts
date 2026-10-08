import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { resultRows } from "#db/client.ts";
import type { Table } from "#db/table.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { isNotNullish } from "#fp";
import { ADMIN_API } from "#routes/auth.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import type {
  CrudApiConfig,
  CrudApiHandlers,
} from "#shared/rest/crud-api-types.ts";
import { okResult } from "#shared/result.ts";
import {
  getAllActivityLog,
  wasActivityLogged,
} from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createIdNameTable,
  type IdNameInput as Input,
  makeIdNameTable,
  type IdNameRow as Row,
} from "#test-utils/rest-fixtures.ts";
import { createTestApiKeyToken, requestAsApiKey } from "#test-utils/session.ts";

const makeTable = (): Table<Row, Input> => makeIdNameTable("widgets");

/** The widget entry the tests build routes for: the attributes surface with
 *  its options child, plus an archive custom route. */
const WIDGET_ENTRY = {
  ...ADMIN_API_RESOURCES.attributes,
  custom: {
    archive: {
      method: "POST",
      subpath: ":widgetId/archive",
    },
  },
  label: "Widget",
  path: "widgets",
} as const satisfies AdminApiResource;

/** The default handler the tests do not pin: it answers the delete envelope,
 *  so a route the test does not stub still answers JSON. */
const ok = () =>
  Promise.resolve(new Response(JSON.stringify({ status: "ok" })));

const nameInputs = {
  toCreateInput: (body: Record<string, unknown>) =>
    okResult({ name: String(body.name) }),
  toUpdateInput: (body: Record<string, unknown>, existing: Row) =>
    okResult({
      name: isNotNullish(body.name) ? String(body.name) : existing.name,
    }),
};

const makeRoutes = <State = never>(
  table: Table<Row, Input>,
  config: Partial<CrudApiConfig<Row, Input, Row, void, State>> &
    Partial<CrudApiHandlers<typeof WIDGET_ENTRY>> = {},
): Record<string, unknown> =>
  defineCrudApi<typeof WIDGET_ENTRY, Row, Input, Row, void, State>(
    WIDGET_ENTRY,
    {
      childHandlers: {
        options: { create: ok, delete: ok, update: ok },
      },
      customHandlers: { archive: ok },
      getAll: () => table.read.many(),
      nameField: "name",
      policy: ADMIN_API,
      table,
      ...nameInputs,
      ...config,
    },
  );

const callRoute = async (
  routes: Record<string, unknown>,
  key: string,
  method: string,
  body?: Record<string, unknown>,
  id?: number,
): Promise<Response> => {
  const handler = routes[key] as (
    request: Request,
    params: Record<string, number>,
  ) => Promise<Response>;
  const apiKey = await createTestApiKeyToken();
  return handler(
    requestAsApiKey(
      `/api/admin/widgets${id === undefined ? "" : `/${id}`}`,
      apiKey,
      {
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
        method,
      },
    ),
    id === undefined ? {} : { widgetId: id },
  );
};

describeWithEnv("defineCrudApi", { db: true }, () => {
  beforeEach(() => createIdNameTable("widgets"));

  test("builds the child routes the table declares", () => {
    const create = () => Promise.resolve(new Response("ok"));
    const remove = () => Promise.resolve(new Response("ok"));
    const update = () => Promise.resolve(new Response("ok"));
    const routes = makeRoutes(makeTable(), {
      childHandlers: {
        options: { create, delete: remove, update },
      },
    });

    expect(routes["POST /api/admin/widgets/:widgetId/options"]).toBe(create);
    expect(routes["PUT /api/admin/widgets/:widgetId/options/:optionId"]).toBe(
      update,
    );
    expect(
      routes["DELETE /api/admin/widgets/:widgetId/options/:optionId"],
    ).toBe(remove);
  });

  test("includes the custom routes the table declares", () => {
    const archive = () => Promise.resolve(new Response("archived"));
    const routes = makeRoutes(makeTable(), {
      customHandlers: { archive },
    });

    expect(routes["POST /api/admin/widgets/:widgetId/archive"]).toBe(archive);
  });

  test("a custom route on the resource's own id segment replaces the standard one", () => {
    const customDelete = () => Promise.resolve(new Response("ok"));
    const replaceEntry = {
      ...WIDGET_ENTRY,
      custom: {
        delete: {
          method: "DELETE",
          subpath: ":widgetId",
        },
      },
    } as const satisfies AdminApiResource;
    const routes = defineCrudApi<typeof replaceEntry, Row, Input, Row, void>(
      replaceEntry,
      {
        childHandlers: {
          options: { create: ok, delete: ok, update: ok },
        },
        customHandlers: { delete: customDelete },
        getAll: () => Promise.resolve([]),
        nameField: "name",
        policy: ADMIN_API,
        table: makeTable(),
        ...nameInputs,
      },
    );

    expect(routes["DELETE /api/admin/widgets/:widgetId"]).toBe(customDelete);
  });

  test("a config that omits a declared custom handler does not compile", () => {
    const build = () =>
      defineCrudApi(WIDGET_ENTRY, {
        childHandlers: {
          options: { create: ok, delete: ok, update: ok },
        },
        // @ts-expect-error the table declares the archive route, so a config
        // without its handler is a compile error
        customHandlers: {},
        getAll: () => Promise.resolve([]),
        nameField: "name",
        policy: ADMIN_API,
        table: makeTable(),
        ...nameInputs,
      });
    expect(typeof build).toBe("function");
  });

  test("creates, strips, hydrates, and logs a row", async () => {
    const table = makeTable();
    const hydrationCalls: number[][] = [];
    const routes = makeRoutes(table, {
      hydrate: (rows) => {
        hydrationCalls.push(rows.map((row) => row.id));
        return Promise.resolve(
          new Map(rows.map((row) => [row.id, { hydrated: `row:${row.id}` }])),
        );
      },
      stripKeys: ["name"],
    });

    const response = await callRoute(
      routes,
      "POST /api/admin/widgets",
      "POST",
      { name: "Created" },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      widget: { hydrated: "row:1", id: 1 },
    });
    expect(await table.read.one({ id: 1 })).toEqual({ id: 1, name: "Created" });
    expect(hydrationCalls).toEqual([[1]]);
    const entry = (await getAllActivityLog()).find(
      (item) => item.message === "Widget 'Created' created",
    );
    expect(entry?.listing_id).toBeNull();
  });

  test("returns a transaction validation error as JSON", async () => {
    const response = await callRoute(
      makeRoutes(makeTable(), {
        afterWrite: () =>
          Promise.reject(
            new TransactionValidationError("Group is no longer valid"),
          ),
      }),
      "POST /api/admin/widgets",
      "POST",
      { name: "Blocked" },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Group is no longer valid",
    });
  });

  test("rethrows an unexpected transaction failure", async () => {
    await expect(
      callRoute(
        makeRoutes(makeTable(), {
          afterWrite: () => Promise.reject(new Error("write failed")),
        }),
        "POST /api/admin/widgets",
        "POST",
        { name: "Broken" },
      ),
    ).rejects.toThrow("write failed");
  });

  test("lists rows through one hydration batch", async () => {
    const table = makeTable();
    await table.insert({ name: "One" });
    await table.insert({ name: "Two" });
    const calls: number[][] = [];
    const routes = makeRoutes(table, {
      hydrate: (rows) => {
        calls.push(rows.map((row) => row.id));
        return Promise.resolve(
          new Map(rows.map((row) => [row.id, { hydrated: row.name }])),
        );
      },
    });

    const response = await callRoute(routes, "GET /api/admin/widgets", "GET");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      widgets: [
        { hydrated: "One", id: 1, name: "One" },
        { hydrated: "Two", id: 2, name: "Two" },
      ],
    });
    expect(calls).toEqual([[1, 2]]);
  });

  test("returns an exact not-found response", async () => {
    const response = await callRoute(
      makeRoutes(makeTable()),
      "GET /api/admin/widgets/:widgetId",
      "GET",
      undefined,
      999,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Widget not found" });
  });

  test("updates and logs a row", async () => {
    const table = makeTable();
    const row = await table.insert({ name: "Original" });
    const response = await callRoute(
      makeRoutes(table),
      "PUT /api/admin/widgets/:widgetId",
      "PUT",
      { name: "Updated" },
      row.id,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      widget: { id: row.id, name: "Updated" },
    });
    expect(await table.read.one({ id: row.id })).toEqual({
      id: row.id,
      name: "Updated",
    });
    expect(await wasActivityLogged("Widget 'Updated' updated")).toBe(true);
  });

  test("passes one pre-update state snapshot to every transactional hook", async () => {
    const table = makeTable();
    const row = await table.insert({ name: "Original" });
    const events: string[] = [];
    const routes = makeRoutes<string>(table, {
      afterWrite: (_tx, _id, _input, state) => {
        events.push(`after:${state}`);
        return Promise.resolve();
      },
      readState: async (tx, id) => {
        const current = resultRows<Row>(
          await tx.execute({
            args: [id],
            sql: "SELECT id, name FROM widgets WHERE id = ?",
          }),
        )[0];
        events.push(`read:${current?.name}`);
        return current?.name ?? null;
      },
      sideEffect: {
        persist: async (tx, id, _value, state) => {
          const current = resultRows<Row>(
            await tx.execute({
              args: [id],
              sql: "SELECT id, name FROM widgets WHERE id = ?",
            }),
          )[0];
          events.push(`side:${current?.name}:${state}`);
        },
        validate: () => Promise.resolve({ value: undefined }),
      },
    });

    const response = await callRoute(
      routes,
      "PUT /api/admin/widgets/:widgetId",
      "PUT",
      { name: "Updated" },
      row.id,
    );

    expect(response.status).toBe(200);
    expect(events).toEqual([
      "read:Original",
      "side:Updated:Original",
      "after:Original",
    ]);
  });

  test("deletes and logs a row", async () => {
    const table = makeTable();
    const row = await table.insert({ name: "Delete me" });
    const response = await callRoute(
      makeRoutes(table),
      "DELETE /api/admin/widgets/:widgetId",
      "DELETE",
      { confirm_identifier: "Delete me" },
      row.id,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(await table.read.one({ id: row.id })).toBeNull();
    expect(await wasActivityLogged("Widget 'Delete me' deleted")).toBe(true);
  });

  test("uses the configured delete operation", async () => {
    const table = makeTable();
    const row = await table.insert({ name: "Cascade" });
    const deleted: number[] = [];
    const routes = makeRoutes(table, {
      onDelete: async (id) => {
        deleted.push(Number(id));
        await table.deleteById(id);
      },
    });

    const response = await callRoute(
      routes,
      "DELETE /api/admin/widgets/:widgetId",
      "DELETE",
      { confirm_identifier: "Cascade" },
      row.id,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(deleted).toEqual([row.id]);
    expect(await table.read.one({ id: row.id })).toBeNull();
  });

  test("PUT returns 404 when the row vanishes before its write reads back", async () => {
    const table = makeTable();
    await table.insert({ name: "Original" });
    // Simulate a concurrent delete landing between the entityRoute lookup and
    // the write's read-back: the update commits against no row, so writeEntity
    // reads nothing back and returns null.
    table.update = () => Promise.resolve(null);

    const routes = makeRoutes(table);
    const handler = routes["PUT /api/admin/widgets/:widgetId"] as (
      req: Request,
      params: Record<string, number>,
    ) => Promise<Response>;
    const apiKey = await createTestApiKeyToken();
    const response = await handler(
      requestAsApiKey("/api/admin/widgets/1", apiKey, {
        body: JSON.stringify({ name: "New" }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      }),
      { widgetId: 1 },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Widget not found" });
  });
});
