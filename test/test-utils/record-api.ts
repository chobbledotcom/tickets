/**
 * One widget record and its JSON routes for the record API tests. The write
 * commands are spies: each one records its arguments and gives the verdict a
 * test names.
 */

import * as v from "valibot";
import type { RouteHandlerFn } from "#routes/router.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";
import {
  type DeleteVerdict,
  defineRecord,
  type RecordShapeOf,
  type WritePlan,
  type WriteVerdict,
} from "#shared/rest/record.ts";
import { type RecordApiConfig, recordApi } from "#shared/rest/record-api.ts";
import { okResult } from "#shared/result.ts";
import { createTestApiKeyToken, requestAsApiKey } from "#test-utils/session.ts";

export type Row = { id: number; name: string };
type Input = { name: string };
export type Shape = RecordShapeOf<Row, Input>;

/** The widget entry: the attributes options child and one custom route.
 * Only a create declares a body schema. */
export const WIDGET_ENTRY = {
  children: { options: ADMIN_API_RESOURCES.attributes.children.options },
  createBodySchema: v.object({ name: v.string("name must be a string") }),
  custom: { archive: { method: "POST", subpath: ":widgetId/archive" } },
  label: "Widget",
  path: "widgets",
  singleSchema: v.looseObject({}),
} as const satisfies AdminApiResource;

/** The plan a widget write receives. */
export type WidgetPlan = WritePlan<string, never>;

type Config = RecordApiConfig<typeof WIDGET_ENTRY, Shape, string>;

/** A handler the tests do not call. */
export const unused: RouteHandlerFn = () =>
  Promise.resolve(new Response("unused"));

/** The arguments each write command received. */
export type WriteCalls = {
  create: [Input, WidgetPlan | undefined][];
  remove: [number, unknown][];
  update: [number, Input, WidgetPlan | undefined][];
};

/** The verdicts the write commands give. */
export type Verdicts = {
  create?: WriteVerdict<Row>;
  remove?: DeleteVerdict;
  update?: WriteVerdict<Row>;
};

const stored: readonly Row[] = [
  { id: 1, name: "One" },
  { id: 2, name: "Two" },
];

/** The widget routes over spy write commands. */
export const widgetRoutes = (
  config: Partial<Config> = {},
  verdicts: Verdicts = {},
  calls: WriteCalls = { create: [], remove: [], update: [] },
): Record<string, RouteHandlerFn> => {
  const record = defineRecord<Shape>()({
    activityName: "Widget",
    api: WIDGET_ENTRY,
    getAll: () => Promise.resolve([...stored]),
    load: (id) => Promise.resolve(stored.find((row) => row.id === id) ?? null),
    logName: (input) => input.name,
    nameField: "name",
    nameOf: (row) => row.name,
    surface: "groups",
  });
  return recordApi<typeof WIDGET_ENTRY, Shape, string>(
    {
      ...record,
      create: (input, plan) => {
        calls.create.push([input, plan as WidgetPlan | undefined]);
        return Promise.resolve(
          verdicts.create ?? { kind: "written", row: { id: 9, ...input } },
        );
      },
      remove: (id, input) => {
        calls.remove.push([id, input]);
        return Promise.resolve(verdicts.remove ?? { kind: "deleted" });
      },
      update: (id, input, plan) => {
        calls.update.push([id, input, plan as WidgetPlan | undefined]);
        return Promise.resolve(
          verdicts.update ?? { kind: "written", row: { id, ...input } },
        );
      },
    },
    {
      childHandlers: {
        options: { create: unused, delete: unused, update: unused },
      },
      customHandlers: { archive: unused },
      toCreateInput: (body) => okResult({ name: body.name }),
      toUpdateInput: (body, existing) =>
        okResult({
          name: body.name === undefined ? existing.name : String(body.name),
        }),
      ...config,
    },
  );
};

/** Call one route with the test API key. */
export const callRoute = async (
  routes: Record<string, RouteHandlerFn>,
  key: string,
  body?: Record<string, unknown>,
  id?: number,
): Promise<Response> => {
  const method = key.split(" ")[0]!;
  const apiKey = await createTestApiKeyToken();
  return routes[key]!(
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

/** A response's status and JSON body. */
export const answerOf = async (
  response: Response,
): Promise<[number, unknown]> => [response.status, await response.json()];
