import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { isNotNullish } from "#fp";
import { TransactionValidationError } from "#shared/db/client.ts";
import type { Table } from "#shared/db/table.ts";
import { type CrudApiConfig, defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  parseOptionalArray,
  parseUpdateName,
  parseUpdateSlug,
  requireStrings,
} from "#shared/rest/crud-parsers.ts";
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

const makeRoutes = (
  table: Table<Row, Input>,
  config: Partial<CrudApiConfig<Row, Input>> = {},
): Record<string, unknown> =>
  defineCrudApi<Row, Input>({
    getAll: () => table.read.many(),
    name: "widgets",
    nameField: "name",
    singular: "Widget",
    table,
    toCreateInput: (body) => okResult({ name: String(body.name) }),
    toUpdateInput: (body, existing) =>
      okResult({
        name: isNotNullish(body.name) ? String(body.name) : existing.name,
      }),
    ...config,
  });

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

  test("parses shared scalar and array inputs", async () => {
    expect(requireStrings({ name: " mutated " }, ["name"])).toEqual({
      ok: true,
      value: { name: "mutated" },
    });
    expect(
      parseOptionalArray([1, 2], "items", (item) => okResult(Number(item))),
    ).toEqual({ ok: true, value: [1, 2] });
    expect(
      await parseUpdateSlug(
        { slug: " New Slug " },
        "old-slug",
        (slug) => slug.trim().toLowerCase().replaceAll(" ", "-"),
        (slug) => Promise.resolve(`index:${slug}`),
      ),
    ).toEqual({ slug: "new-slug", slugIndex: "index:new-slug" });
    expect(
      await parseUpdateSlug(
        {},
        "old-slug",
        (slug) => slug,
        (slug) => Promise.resolve(`index:${slug}`),
      ),
    ).toEqual({ slug: "old-slug", slugIndex: "index:old-slug" });
    expect(parseUpdateName({ name: " Updated " }, "Original")).toEqual({
      ok: true,
      value: "Updated",
    });
    expect(parseUpdateName({}, "Original")).toEqual({
      ok: true,
      value: "Original",
    });
    expect(parseUpdateName({ name: "" }, "Original")).toEqual({
      error: "name cannot be empty",
      ok: false,
    });
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
