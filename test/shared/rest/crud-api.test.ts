import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import type { Table } from "#shared/db/table.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createIdNameTable,
  type IdNameInput as Input,
  makeIdNameTable,
  type IdNameRow as Row,
} from "#test-utils/rest-fixtures.ts";
import { createTestApiKeyToken, requestAsApiKey } from "#test-utils/session.ts";

const makeTable = (): Table<Row, Input> => makeIdNameTable("widgets");

const makeRoutes = (table: Table<Row, Input>): Record<string, unknown> =>
  defineCrudApi<Row, Input>({
    getAll: () => Promise.resolve([]),
    name: "widgets",
    nameField: "name",
    singular: "Widget",
    table,
    toCreateInput: (body) => ({ input: { name: String(body.name) }, ok: true }),
    toUpdateInput: (body, existing) => ({
      input: { name: body.name != null ? String(body.name) : existing.name },
      ok: true,
    }),
  });

describeWithEnv("defineCrudApi write not-found", { db: true }, () => {
  beforeEach(() => createIdNameTable("widgets"));

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
