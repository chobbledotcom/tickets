/**
 * The five standard JSON handlers one record's API builds: the envelopes, the
 * statuses, the body schema, the mappers, the side-effect plan, and the
 * delete confirmation.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { errorResult, okResult } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  answerOf,
  callRoute,
  type Row,
  type WriteCalls,
  widgetRoutes,
} from "#test-utils/record-api.ts";
import type { AdminSession } from "#types";

const newCalls = (): WriteCalls => ({ create: [], remove: [], update: [] });

/** Extra fields for every row, tagged with the hook that added them. */
const tagged =
  (tag: string, seen: number[][]) =>
  (rows: Row[]): Promise<Map<number, Record<string, unknown>>> => {
    seen.push(rows.map((row) => row.id));
    return Promise.resolve(new Map(rows.map((row) => [row.id, { tag }])));
  };

const refused = { kind: "refused", message: "Nope" } as const;
const missing = { kind: "not-found" } as const;
const notFoundAnswer = [404, { error: "Widget not found" }];

describeWithEnv("the record API handlers", { db: true }, () => {
  test("the list answers every row through one hydration and its extras", async () => {
    const seen: number[][] = [];
    const levels: string[] = [];
    const routes = widgetRoutes({
      hydrate: tagged("hydrated", seen),
      listExtras: (session) => {
        levels.push(session.adminLevel);
        return { total: 2 };
      },
    });

    expect(
      await answerOf(await callRoute(routes, "GET /api/admin/widgets")),
    ).toEqual([
      200,
      {
        total: 2,
        widgets: [
          { id: 1, name: "One", tag: "hydrated" },
          { id: 2, name: "Two", tag: "hydrated" },
        ],
      },
    ]);
    expect(seen).toEqual([[1, 2]]);
    expect(levels).toEqual(["owner"]);
  });

  test("a list with no hooks answers the stored rows", async () => {
    const response = await callRoute(widgetRoutes(), "GET /api/admin/widgets");

    expect(await answerOf(response)).toEqual([
      200,
      {
        widgets: [
          { id: 1, name: "One" },
          { id: 2, name: "Two" },
        ],
      },
    ]);
  });

  test("a read hydrates, strips, and projects its row", async () => {
    const seen: number[][] = [];
    const projected: [Record<string, unknown>, string][] = [];
    const routes = widgetRoutes({
      hydrate: tagged("read", seen),
      hydrateAfterWrite: tagged("written", []),
      projectResponse: (row, session: AdminSession) => {
        projected.push([row, session.adminLevel]);
        return { ...row, projected: true };
      },
      stripKeys: ["name"],
    });

    const response = await callRoute(
      routes,
      "GET /api/admin/widgets/:widgetId",
      undefined,
      2,
    );

    expect(await answerOf(response)).toEqual([
      200,
      { widget: { id: 2, projected: true, tag: "read" } },
    ]);
    expect(seen).toEqual([[2]]);
    expect(projected).toEqual([[{ id: 2, tag: "read" }, "owner"]]);
  });

  test("a hydration that skips a row leaves the row as stored", async () => {
    const routes = widgetRoutes({
      hydrate: () => Promise.resolve(new Map([[5, { tag: "other" }]])),
    });

    const response = await callRoute(
      routes,
      "GET /api/admin/widgets/:widgetId",
      undefined,
      1,
    );

    expect(await answerOf(response)).toEqual([
      200,
      { widget: { id: 1, name: "One" } },
    ]);
  });

  test("a read of a missing row answers 404", async () => {
    const response = await callRoute(
      widgetRoutes(),
      "GET /api/admin/widgets/:widgetId",
      undefined,
      99,
    );

    expect(await answerOf(response)).toEqual(notFoundAnswer);
  });

  test("a create answers 201 with the row its write hydration builds", async () => {
    const calls = newCalls();
    const sessions: (string | undefined)[] = [];
    const routes = widgetRoutes(
      {
        hydrate: tagged("read", []),
        hydrateAfterWrite: tagged("written", []),
        toCreateInput: (body, existing, session) => {
          sessions.push(`${existing}:${session?.adminLevel}`);
          return okResult({ name: body.name });
        },
      },
      {},
      calls,
    );

    const response = await callRoute(routes, "POST /api/admin/widgets", {
      name: "Made",
    });

    expect(await answerOf(response)).toEqual([
      201,
      { widget: { id: 9, name: "Made", tag: "written" } },
    ]);
    expect(calls.create).toEqual([[{ name: "Made" }, undefined]]);
    expect(sessions).toEqual(["null:owner"]);
  });

  test("a create body the schema refuses never reaches the mapper", async () => {
    const calls = newCalls();
    const response = await callRoute(
      widgetRoutes({}, {}, calls),
      "POST /api/admin/widgets",
      { name: 7 },
    );

    expect(await answerOf(response)).toEqual([
      400,
      { error: "name must be a string" },
    ]);
    expect(calls.create).toEqual([]);
  });

  test("a mapper refusal answers 400 and writes nothing", async () => {
    const calls = newCalls();
    const routes = widgetRoutes(
      { toCreateInput: () => errorResult("Bad widget") },
      {},
      calls,
    );

    const response = await callRoute(routes, "POST /api/admin/widgets", {
      name: "Made",
    });

    expect(await answerOf(response)).toEqual([400, { error: "Bad widget" }]);
    expect(calls.create).toEqual([]);
  });

  test("a refused create answers 400 with the refusal", async () => {
    const response = await callRoute(
      widgetRoutes({}, { create: refused }),
      "POST /api/admin/widgets",
      { name: "Made" },
    );

    expect(await answerOf(response)).toEqual([400, { error: "Nope" }]);
  });

  test("a create that writes no row answers 404", async () => {
    const response = await callRoute(
      widgetRoutes({}, { create: missing }),
      "POST /api/admin/widgets",
      { name: "Made" },
    );

    expect(await answerOf(response)).toEqual(notFoundAnswer);
  });

  test("an update with no schema maps the raw body against the stored row", async () => {
    const calls = newCalls();
    const existing: [Row, string | undefined][] = [];
    const routes = widgetRoutes(
      {
        toUpdateInput: (body, row, session) => {
          existing.push([row, session?.adminLevel]);
          return okResult({ name: String(body.name) });
        },
      },
      {},
      calls,
    );

    const response = await callRoute(
      routes,
      "PUT /api/admin/widgets/:widgetId",
      { name: 7 },
      2,
    );

    expect(await answerOf(response)).toEqual([
      200,
      { widget: { id: 2, name: "7" } },
    ]);
    expect(calls.update).toEqual([[2, { name: "7" }, undefined]]);
    expect(existing).toEqual([[{ id: 2, name: "Two" }, "owner"]]);
  });

  test("a refused update answers 400 and a vanished one 404", async () => {
    const put = (verdicts: Parameters<typeof widgetRoutes>[1]) =>
      callRoute(
        widgetRoutes({}, verdicts),
        "PUT /api/admin/widgets/:widgetId",
        { name: "New" },
        1,
      );

    expect(await answerOf(await put({ update: refused }))).toEqual([
      400,
      { error: "Nope" },
    ]);
    expect(await answerOf(await put({ update: missing }))).toEqual(
      notFoundAnswer,
    );
  });
});
