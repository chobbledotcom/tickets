/**
 * One widget record and its page routes for the record page tests. The
 * record lives on the holidays surface, so its pages sit under
 * `/admin/holidays`.
 */

import { expect } from "@std/expect";
import type { CrudHandlers } from "#routes/admin/route-tables.ts";
import type { FormSchema } from "#shared/forms/definition.ts";
import {
  type AdminRecord,
  defineRecord,
  type RecordShapeOf,
  type RecordSpec,
} from "#shared/rest/record.ts";
import {
  type RecordPagesConfig,
  recordPages,
} from "#shared/rest/record-pages.ts";
import { okResult } from "#shared/result.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Row = { id: number; name: string };
export type Input = { name: string };
export type Shape = RecordShapeOf<Row, Input>;
export type Values = { name: string };
export type WriteSet = NonNullable<RecordSpec<Shape>["write"]>;
type PagesConfig = RecordPagesConfig<Shape, Values, Values, string>;

export const form = (name: string): FormSchema<Values> => ({
  fields: [],
  validate: () => ({ valid: true, values: { name } }),
});

export const toInput = (values: Values): Input => ({ name: values.name });

/** The widget record. Row 7 is stored, and the writes answer as written. */
export const recordWith = (
  write: Partial<WriteSet> = {},
  spec: Partial<RecordSpec<Shape>> = {},
): AdminRecord<Shape> =>
  defineRecord<Shape>()({
    activityName: "Widget",
    getAll: () => Promise.resolve([{ id: 7, name: "Widget" }]),
    load: (id) => Promise.resolve(id === 7 ? { id: 7, name: "Widget" } : null),
    logName: (input) => input.name,
    nameOf: (row) => row.name,
    rule: (input) => okResult(input),
    surface: "holidays",
    ...spec,
    write: {
      create: () =>
        Promise.resolve({ kind: "written", row: { id: 9, name: "New" } }),
      remove: () => Promise.resolve({ kind: "deleted" }),
      update: () =>
        Promise.resolve({ kind: "written", row: { id: 7, name: "Edited" } }),
      ...write,
    },
  });

export const pagesFor = (
  config: Partial<PagesConfig> = {},
  write: Partial<WriteSet> = {},
): CrudHandlers =>
  recordPages(recordWith(write), { form: form("Widget"), toInput, ...config });

/** A guarded form POST from the test owner's session. */
export const formRequest = async (
  path: string,
  data: TestFormValues = {},
): Promise<Request> => {
  const cookie = await testCookie();
  const csrfToken = await testCsrfToken();
  return mockFormRequest(path, { csrf_token: csrfToken, ...data }, cookie);
};

export const createAs = async (
  pages: CrudHandlers,
  name = "Widget",
): Promise<Response> =>
  pages.createPost(await formRequest("/admin/holidays", { name }));

export const editAs = async (pages: CrudHandlers, id = 7): Promise<Response> =>
  pages.editPost(await formRequest(`/admin/holidays/${id}/edit`), { id });

/** Post the delete confirmation for row 7 with the typed name. */
export const deleteAs = async (
  pages: CrudHandlers,
  typed = "Widget",
): Promise<Response> =>
  pages.deletePost(
    await formRequest("/admin/holidays/7/delete", {
      confirm_identifier: typed,
    }),
    { id: 7 },
  );

const pathOf = (response: Response): string =>
  new URL(response.headers.get("location") ?? "", "http://localhost").pathname;

/** Assert the PRG answer a page gives after a write. */
export const expectRedirect = (response: Response, path: string): void => {
  expect(response.status).toBe(302);
  expect(pathOf(response)).toBe(path);
};

export const editUrl = "/admin/holidays/7/edit";

export const refusedWrite = () =>
  Promise.resolve({ kind: "refused" as const, message: "Nope" });
