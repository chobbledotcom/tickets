import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { Holiday, HolidayInput } from "#db/holidays.ts";
import type { RouteHandlerFn } from "#routes/router.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import {
  defineRecord,
  type RecordShapeOf,
  recordSurfaceOf,
} from "#shared/rest/record.ts";
import {
  recordApi,
  recordJsonDeletePolicy,
  recordJsonPolicy,
} from "#shared/rest/record-api.ts";
import { okResult } from "#shared/result.ts";
import { unused, widgetRoutes } from "#test-utils/record-api.ts";

type HolidayShape = RecordShapeOf<Holiday, HolidayInput>;
const holidayFields = {
  activityName: "Holiday",
  getAll: () => Promise.resolve([] as Holiday[]),
  list: "holidays",
  logName: (input: HolidayInput) => input.name,
  nameOf: (row: Holiday) => row.name,
  rule: (input: HolidayInput) => okResult(input),
  surface: "holidays",
} as const;

test("refuses a record with no JSON resource", () => {
  const record = defineRecord<HolidayShape>()(holidayFields);
  expect(() =>
    recordApi<typeof ADMIN_API_RESOURCES.holidays, HolidayShape>(
      record,
      {} as never,
    ),
  ).toThrow("The record for holidays declares no JSON resource");
});

test("refuses a record with no display-name column", () => {
  const record = defineRecord<HolidayShape>()({
    ...holidayFields,
    api: ADMIN_API_RESOURCES.holidays,
  });
  expect(() =>
    recordApi<typeof ADMIN_API_RESOURCES.holidays, HolidayShape>(
      record,
      {} as never,
    ),
  ).toThrow("The Holiday record names no display-name column");
});

test("the record JSON policy admits an API key and the list roles", () => {
  expect(recordJsonPolicy(recordSurfaceOf("groups"))).toEqual({
    allowApiKey: true,
    body: "json",
    roles: ["owner", "manager", "editor"],
  });
});

test("the record delete policy admits the delete page roles", () => {
  expect(recordJsonDeletePolicy(recordSurfaceOf("groups"))).toEqual({
    allowApiKey: true,
    body: "json",
    roles: ["owner", "manager"],
  });
});

test("the route table carries the standard, child, and custom routes", () => {
  const archive: RouteHandlerFn = () => Promise.resolve(new Response("a"));
  const optionCreate: RouteHandlerFn = () => Promise.resolve(new Response("c"));
  const routes = widgetRoutes({
    childHandlers: {
      options: { create: optionCreate, delete: unused, update: unused },
    },
    customHandlers: { archive },
  });

  expect(Object.keys(routes)).toEqual([
    "GET /api/admin/widgets",
    "GET /api/admin/widgets/:widgetId",
    "POST /api/admin/widgets",
    "PUT /api/admin/widgets/:widgetId",
    "DELETE /api/admin/widgets/:widgetId",
    "POST /api/admin/widgets/:widgetId/options",
    "PUT /api/admin/widgets/:widgetId/options/:optionId",
    "DELETE /api/admin/widgets/:widgetId/options/:optionId",
    "POST /api/admin/widgets/:widgetId/archive",
  ]);
  expect(routes["POST /api/admin/widgets/:widgetId/options"]).toBe(
    optionCreate,
  );
  expect(routes["POST /api/admin/widgets/:widgetId/archive"]).toBe(archive);
  expect(routes["GET /api/admin/widgets"]).not.toBe(unused);
});

test("an override replaces each standard route it names", () => {
  const overrides = {
    create: (() => Promise.resolve(new Response("create"))) as RouteHandlerFn,
    delete: (() => Promise.resolve(new Response("delete"))) as RouteHandlerFn,
    get: (() => Promise.resolve(new Response("get"))) as RouteHandlerFn,
    list: (() => Promise.resolve(new Response("list"))) as RouteHandlerFn,
    update: (() => Promise.resolve(new Response("update"))) as RouteHandlerFn,
  };
  const routes = widgetRoutes({ overrides });

  expect([
    routes["GET /api/admin/widgets"],
    routes["GET /api/admin/widgets/:widgetId"],
    routes["POST /api/admin/widgets"],
    routes["PUT /api/admin/widgets/:widgetId"],
    routes["DELETE /api/admin/widgets/:widgetId"],
  ]).toEqual([
    overrides.list,
    overrides.get,
    overrides.create,
    overrides.update,
    overrides.delete,
  ]);
});

test("a resource with no children or custom routes serves the five routes", () => {
  const record = defineRecord<HolidayShape>()({
    ...holidayFields,
    api: ADMIN_API_RESOURCES.holidays,
    nameField: "name",
  });
  const routes = recordApi<typeof ADMIN_API_RESOURCES.holidays, HolidayShape>(
    record,
    { toCreateInput: okResult, toUpdateInput: okResult } as never,
  );

  expect(Object.keys(routes)).toEqual([
    "GET /api/admin/holidays",
    "GET /api/admin/holidays/:holidayId",
    "POST /api/admin/holidays",
    "PUT /api/admin/holidays/:holidayId",
    "DELETE /api/admin/holidays/:holidayId",
  ]);
});
