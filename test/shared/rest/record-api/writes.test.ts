/**
 * The record API's side-effect plan, its confirmed delete, and the roles each
 * route admits.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { TxScope } from "#db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  answerOf,
  callRoute,
  type Verdicts,
  type WriteCalls,
  widgetRoutes,
} from "#test-utils/record-api.ts";
import {
  createTestEditorSession,
  requestAsSession,
} from "#test-utils/session.ts";

const newCalls = (): WriteCalls => ({ create: [], remove: [], update: [] });

/** A side effect that records what its validate and persist steps see. */
const recordingSideEffect = (seen: unknown[]) => ({
  persist: (_tx: TxScope, id: number, value: string, state: null) => {
    seen.push(["persist", id, value, state]);
    return Promise.resolve();
  },
  validate: (
    input: { name: string },
    body: Record<string, unknown>,
    existing: unknown,
  ) => {
    seen.push(["validate", input, body, existing]);
    return Promise.resolve({ value: "prepared" });
  },
});

const tx = {} as TxScope;

const confirmed = (name: string) => ({ confirm_identifier: name });

const deleteWith = (verdicts: Verdicts, calls = newCalls(), name = "One") =>
  callRoute(
    widgetRoutes({}, verdicts, calls),
    "DELETE /api/admin/widgets/:widgetId",
    confirmed(name),
    1,
  );

describeWithEnv("the record API writes", { db: true }, () => {
  test("a create hands its side effect to the write as a plan", async () => {
    const calls = newCalls();
    const seen: unknown[] = [];
    await callRoute(
      widgetRoutes({ sideEffect: recordingSideEffect(seen) }, {}, calls),
      "POST /api/admin/widgets",
      { name: "Made" },
    );
    const plan = calls.create[0]![1]!;

    expect(await plan.prepare!({ name: "Ruled" }, null)).toEqual({
      value: "prepared",
    });
    await plan.persist!(tx, 9, "prepared", null);
    expect(seen).toEqual([
      ["validate", { name: "Ruled" }, { name: "Made" }, null],
      ["persist", 9, "prepared", null],
    ]);
  });

  test("an update plan validates against the stored row", async () => {
    const calls = newCalls();
    const seen: unknown[] = [];
    await callRoute(
      widgetRoutes({ sideEffect: recordingSideEffect(seen) }, {}, calls),
      "PUT /api/admin/widgets/:widgetId",
      { name: "New" },
      2,
    );

    await calls.update[0]![2]!.prepare!({ name: "New" }, null);
    expect(seen).toEqual([
      ["validate", { name: "New" }, { name: "New" }, { id: 2, name: "Two" }],
    ]);
  });

  test("a confirmed delete answers ok", async () => {
    const calls = newCalls();

    expect(await answerOf(await deleteWith({}, calls))).toEqual([
      200,
      { status: "ok" },
    ]);
    expect(calls.remove).toEqual([[1, undefined]]);
  });

  test("a delete whose name does not match deletes nothing", async () => {
    const calls = newCalls();

    expect(await answerOf(await deleteWith({}, calls, "Wrong"))).toEqual([
      400,
      {
        error:
          "Widget name does not match. Please provide the exact widget name in confirm_identifier.",
      },
    ]);
    expect(calls.remove).toEqual([]);
  });

  test("a refused delete answers 400 and a vanished one 404", async () => {
    expect(
      await answerOf(
        await deleteWith({ remove: { kind: "refused", message: "In use" } }),
      ),
    ).toEqual([400, { error: "In use" }]);
    expect(
      await answerOf(await deleteWith({ remove: { kind: "not-found" } })),
    ).toEqual([404, { error: "Widget not found" }]);
  });

  test("an editor reads the widgets but cannot delete one", async () => {
    const { cookie } = await createTestEditorSession();
    const routes = widgetRoutes();
    const asEditor = (key: string, init: RequestInit) =>
      routes[key]!(
        requestAsSession(
          "/api/admin/widgets/1",
          { cookie, csrfToken: "editor-csrf" },
          init,
        ),
        { widgetId: 1 },
      );

    const read = await asEditor("GET /api/admin/widgets/:widgetId", {
      method: "GET",
    });
    const remove = await asEditor("DELETE /api/admin/widgets/:widgetId", {
      body: JSON.stringify(confirmed("One")),
      headers: { "content-type": "application/json" },
      method: "DELETE",
    });

    expect(await answerOf(read)).toEqual([
      200,
      { widget: { id: 1, name: "One" } },
    ]);
    expect(remove.status).toBe(403);
  });
});
