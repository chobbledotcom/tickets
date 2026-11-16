/**
 * One widget record and its page routes for the record page tests. The
 * record lives on the holidays surface, so its pages sit under
 * `/admin/holidays`.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { CrudHandlers } from "#routes/admin/route-tables.ts";
import type { FormSchema } from "#shared/forms/definition.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type {
  AdminRecord,
  RecordShapeOf,
  RecordSpec,
} from "#shared/rest/record.ts";
import {
  type RecordPagesConfig,
  recordPages,
} from "#shared/rest/record-pages.ts";
import {
  expectRedirect as expectRedirectTo,
  expectRedirectWithFlash,
} from "#test-utils/assertions/redirect.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Row = { id: number; name: string };
export type Input = { name: string };
export type Shape = RecordShapeOf<Row, Input>;
export type Values = { name: string };
export type WriteSet = NonNullable<RecordSpec<Shape>["write"]>;
export type PagesConfig = RecordPagesConfig<Shape, Values, Values, string>;

export const form = (name: string): FormSchema<Values> => ({
  fields: [],
  validate: () => ({ valid: true, values: { name } }),
});

export const toInput = (values: Values): Input => ({ name: values.name });

/** The one stored widget row. */
const WIDGET = { id: 7, name: "Widget" };

/** The widget record. Row 7 is stored, and the writes answer as written. */
export const recordWith = (
  write: Partial<WriteSet> = {},
  spec: Partial<RecordSpec<Shape>> = {},
): AdminRecord<Shape> =>
  defineNamedRowRecord<Shape>()({
    activityName: "Widget",
    getAll: () => Promise.resolve([WIDGET]),
    load: () => Promise.resolve(WIDGET),
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

/** The default pages over a widget record that declares `spec`. */
export const pagesForRecord = (
  spec: Partial<RecordSpec<Shape>>,
): CrudHandlers =>
  recordPages(recordWith({}, spec), { form: form("Widget"), toInput });

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

/** Assert the PRG answer a page gives after a write: a 302 to this path. */
export const expectRedirect = (response: Response, path: string): void => {
  expect(new URL(expectRedirectTo(response), "http://localhost").pathname).toBe(
    path,
  );
};

export const editUrl = "/admin/holidays/7/edit";

export const refusedWrite = () =>
  Promise.resolve({ kind: "refused" as const, message: "Nope" });

/** The page config, the landing path, and the flash of one case. */
export type LandingRow = [
  config: Partial<PagesConfig>,
  path: string,
  flash: string,
];

/** What every row in one group shares: the action, the writes it meets, and
 * whether the flash is a success. */
export type LandingGroup = {
  act: (pages: CrudHandlers) => Promise<Response>;
  succeeded: boolean;
  write?: Partial<WriteSet>;
};

/** Register one test per row, named by its key. */
export const testLandings = (
  group: LandingGroup,
  rows: Readonly<Record<string, LandingRow>>,
): void => {
  for (const [name, [config, path, flash]] of Object.entries(rows)) {
    test(name, async () => {
      expectRedirectWithFlash(
        path,
        flash,
        group.succeeded,
      )(await group.act(pagesFor(config, group.write)));
    });
  }
};
