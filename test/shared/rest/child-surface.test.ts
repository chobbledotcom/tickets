/**
 * One child surface's write routes: the parent gate, the child pick, the
 * confirmed delete, the text update, and the text-named child's three routes.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  apiChildSurface,
  childTextConfig,
  recordChildSurface,
} from "#shared/rest/child-surface.ts";
import { withRequiredText } from "#shared/rest/crud-parsers.ts";
import { recordSurfaceOf } from "#shared/rest/record.ts";
import { recordJsonPolicy } from "#shared/rest/record-api.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestApiKeyToken,
  createTestEditorSession,
  requestAsApiKey,
  requestAsSession,
} from "#test-utils/session.ts";

type Option = { id: number; text: string };
type Parent = { id: number; options: Option[] };

const parentRow: Parent = {
  id: 1,
  options: [
    { id: 4, text: "Red" },
    { id: 5, text: "Blue" },
  ],
};

const lookup = (id: number): Promise<Parent | null> =>
  Promise.resolve(id === 1 ? parentRow : null);

const surface = () =>
  apiChildSurface<Parent, Option>({
    childIdParam: "optionId",
    childLabel: "Option",
    childrenOf: (parent) => parent.options,
    lookup,
    parentIdParam: "attributeId",
    parentLabel: "Attribute",
    policy: recordJsonPolicy(recordSurfaceOf("groups")),
  });

/** Call one route with the test API key and a JSON body. */
const call = async (
  handler: RouteHandlerFn,
  params: Record<string, number>,
  body: Record<string, unknown> = {},
): Promise<[number, unknown]> => {
  const apiKey = await createTestApiKeyToken();
  const response = await handler(
    requestAsApiKey("/api/admin/attributes/1/options", apiKey, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    params,
  );
  return [response.status, await response.json()];
};

const both = { attributeId: 1, optionId: 5 };

/** Text-named writes that record each call. */
const recordingWrites = (seen: unknown[], refusal?: Response | null) => ({
  add: (parent: Parent, text: string) => {
    seen.push(["add", parent.id, text]);
    return Promise.resolve();
  },
  remove: (parent: Parent, child: Option) => {
    seen.push(["remove", parent.id, child.id]);
    return Promise.resolve();
  },
  rename: (parent: Parent, child: Option, text: string) => {
    seen.push(["rename", parent.id, child.id, text]);
    return Promise.resolve();
  },
  respond: (parentId: number, status?: number) => {
    seen.push(["respond", parentId, status]);
    return Promise.resolve(jsonResponse({ parentId }, status));
  },
  ...(refusal === undefined ? {} : { refuseAdd: () => refusal }),
});

const textRoutes = (seen: unknown[], refusal?: Response | null) =>
  childTextConfig(
    surface(),
    "Option text",
    withRequiredText,
    (child) => child.text,
    recordingWrites(seen, refusal),
  );

describeWithEnv("one child surface", { db: true }, () => {
  test("the parent gate hands the loaded parent and body to its handler", async () => {
    const seen: unknown[] = [];
    const route: RouteHandlerFn = (request, params) =>
      surface().parent(request, params, (parent, body) => {
        seen.push([parent.id, body]);
        return Promise.resolve(jsonResponse({ ok: true }));
      });

    expect(await call(route, { attributeId: 1 }, { text: "Hi" })).toEqual([
      200,
      { ok: true },
    ]);
    expect(seen).toEqual([[1, { text: "Hi" }]]);
  });

  test("a missing parent answers 404 with the parent label", async () => {
    const { create } = textRoutes([]);

    expect(await call(create, { attributeId: 2 }, { text: "x" })).toEqual([
      404,
      { error: "Attribute not found" },
    ]);
  });

  test("a missing child answers 404 with the child label", async () => {
    const seen: unknown[] = [];
    const { update } = textRoutes(seen);

    expect(
      await call(update, { attributeId: 1, optionId: 9 }, { text: "x" }),
    ).toEqual([404, { error: "Option not found" }]);
    expect(seen).toEqual([]);
  });

  test("a create adds the text and answers the parent with 201", async () => {
    const seen: unknown[] = [];

    expect(
      await call(
        textRoutes(seen).create,
        { attributeId: 1 },
        { text: "Green" },
      ),
    ).toEqual([201, { parentId: 1 }]);
    expect(seen).toEqual([
      ["add", 1, "Green"],
      ["respond", 1, 201],
    ]);
  });

  test("a create the parent refuses answers the refusal and adds nothing", async () => {
    const seen: unknown[] = [];
    const routes = textRoutes(seen, jsonResponse({ error: "Full" }, 409));

    expect(
      await call(routes.create, { attributeId: 1 }, { text: "x" }),
    ).toEqual([409, { error: "Full" }]);
    expect(seen).toEqual([]);
  });

  test("a create the parent allows adds the text", async () => {
    const seen: unknown[] = [];
    const routes = textRoutes(seen, null);

    expect(
      await call(routes.create, { attributeId: 1 }, { text: "x" }),
    ).toEqual([201, { parentId: 1 }]);
    expect(seen).toEqual([
      ["add", 1, "x"],
      ["respond", 1, 201],
    ]);
  });

  test("a create without text answers the reader's 400", async () => {
    const seen: unknown[] = [];

    const [status] = await call(textRoutes(seen).create, { attributeId: 1 });

    expect(status).toBe(400);
    expect(seen).toEqual([]);
  });

  test("an update renames the picked child and answers the parent", async () => {
    const seen: unknown[] = [];

    expect(await call(textRoutes(seen).update, both, { text: "Navy" })).toEqual(
      [200, { parentId: 1 }],
    );
    expect(seen).toEqual([
      ["rename", 1, 5, "Navy"],
      ["respond", 1, undefined],
    ]);
  });

  test("a confirmed delete removes the picked child and answers ok", async () => {
    const seen: unknown[] = [];
    const body = { confirm_identifier: "Blue" };

    expect(await call(textRoutes(seen).delete, both, body)).toEqual([
      200,
      { status: "ok" },
    ]);
    expect(seen).toEqual([["remove", 1, 5]]);
  });

  test("a delete whose text does not match removes nothing", async () => {
    const seen: unknown[] = [];
    const body = { confirm_identifier: "Red" };

    expect(await call(textRoutes(seen).delete, both, body)).toEqual([
      400,
      {
        error:
          "Option text does not match. Please provide the exact option text in confirm_identifier.",
      },
    ]);
    expect(seen).toEqual([]);
  });

  test("a record child surface answers the roles of its parent page", async () => {
    const { cookie } = await createTestEditorSession();
    const owned = recordChildSurface<Parent, Option>(
      recordSurfaceOf("holidays"),
      "attributeId",
      "Attribute",
      "optionId",
      "Option",
      lookup,
      (parent) => parent.options,
    );
    const route: RouteHandlerFn = (request, params) =>
      owned.parent(request, params, (parent) =>
        Promise.resolve(jsonResponse({ id: parent.id })),
      );
    const asEditor = requestAsSession(
      "/api/admin/attributes/1/options",
      { cookie, csrfToken: "editor-csrf" },
      {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );

    expect((await route(asEditor, { attributeId: 1 })).status).toBe(403);
    expect(await call(route, { attributeId: 1 })).toEqual([200, { id: 1 }]);
  });
});
