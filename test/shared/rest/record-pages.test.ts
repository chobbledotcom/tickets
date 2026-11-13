/**
 * Direct unit tests for the record page routes: the parse step, the edit
 * refusal answers, the skipped-route guards, and the default delete render.
 * The integration suites drive the same pages through real routes; these
 * mirror the branches a single record's fake supplies.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
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
import { describeWithEnv } from "#test-utils/db.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

type Row = { id: number; name: string };
type Input = { name: string };
type Shape = RecordShapeOf<Row, Input>;
type Values = { name: string };
type WriteSet = NonNullable<RecordSpec<Shape>["write"]>;
type PagesConfig = RecordPagesConfig<Shape, Values, Values>;

const form = (name: string): FormSchema<Values> => ({
  fields: [],
  validate: () => ({ valid: true, values: { name } }),
});

const toInput = (values: Values): Input => ({ name: values.name });

const recordWith = (write: Partial<WriteSet> = {}): AdminRecord<Shape> =>
  defineRecord<Shape>()({
    activityName: "Widget",
    getAll: () => Promise.resolve([]),
    load: (id) => Promise.resolve(id === 7 ? { id: 7, name: "Widget" } : null),
    logName: (input) => input.name,
    nameOf: (row) => row.name,
    rule: (input) => okResult(input),
    surface: "holidays",
    write: {
      create: () =>
        Promise.resolve({ kind: "written", row: { id: 9, name: "New" } }),
      remove: () => Promise.resolve({ kind: "deleted" }),
      update: () =>
        Promise.resolve({ kind: "written", row: { id: 7, name: "Edited" } }),
      ...write,
    },
  });

const pagesFor = (
  config: Partial<PagesConfig> = {},
  write: Partial<WriteSet> = {},
): CrudHandlers =>
  recordPages(recordWith(write), { form: form("Widget"), toInput, ...config });

/** A guarded form POST from the test owner's session. */
const formRequest = async (
  path: string,
  data: TestFormValues = {},
): Promise<Request> => {
  const cookie = await testCookie();
  const csrfToken = await testCsrfToken();
  return mockFormRequest(path, { csrf_token: csrfToken, ...data }, cookie);
};

const createAs = async (
  pages: CrudHandlers,
  name = "Widget",
): Promise<Response> =>
  pages.createPost(await formRequest("/admin/holidays", { name }));

const editAs = async (pages: CrudHandlers, id = 7): Promise<Response> =>
  pages.editPost(await formRequest(`/admin/holidays/${id}/edit`), { id });

const pathOf = (response: Response): string =>
  new URL(response.headers.get("location") ?? "", "http://localhost").pathname;

/** Assert the PRG answer a page gives after a successful write. */
const expectRedirect = (response: Response, path: string): void => {
  expect(response.status).toBe(302);
  expect(pathOf(response)).toBe(path);
};

const editUrl = "/admin/holidays/7/edit";

const refusedUpdate = () =>
  Promise.resolve({ kind: "refused" as const, message: "Nope" });

describeWithEnv("the record page routes", { db: true }, () => {
  test("a create that writes no row answers the 404 page", async () => {
    const notFound = () => Promise.resolve({ kind: "not-found" as const });

    expect((await createAs(pagesFor({}, { create: notFound }))).status).toBe(
      404,
    );
  });

  test("a create that writes a row redirects to its save page", async () => {
    expectRedirect(await createAs(pagesFor()), "/admin/holidays/9");
  });

  test("a create page that declares no form refuses the submission", async () => {
    const pages = recordPages<Shape, Values>(recordWith(), { toInput });

    await expect(createAs(pages)).rejects.toThrow(
      "The record page declares no form",
    );
  });

  test("an edit page that declares no mapper refuses the edit", async () => {
    const pages = recordPages<Shape, Values>(recordWith(), {
      editForm: form("Widget"),
      form: form("Widget"),
    });

    await expect(editAs(pages)).rejects.toThrow(
      "The record page declares no edit input mapper",
    );
  });

  test("an edit form without its own mapper uses the create mapper", async () => {
    const updates: [number, Input][] = [];
    const pages = pagesFor(
      { editForm: form("Edited name") },
      {
        update: (id, input) => {
          updates.push([id, input]);
          return Promise.resolve({
            kind: "written",
            row: { id, name: input.name },
          });
        },
      },
    );

    expectRedirect(await editAs(pages), "/admin/holidays/7");
    expect(updates).toEqual([[7, { name: "Edited name" }]]);
  });

  test("a refused edit renders in place when the page supplies a renderer", async () => {
    const calls: [number, string][] = [];
    const pages = pagesFor(
      {
        renderEditError: (id, _session, _form, error) => {
          calls.push([id, error]);
          return Promise.resolve(new Response("panel", { status: 400 }));
        },
      },
      { update: refusedUpdate },
    );

    const response = await editAs(pages);

    expect(calls).toEqual([[7, "Nope"]]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("panel");
  });

  test("a refused edit without a renderer redirects to its edit page", async () => {
    const pages = pagesFor({}, { update: refusedUpdate });

    expectRedirect(await editAs(pages), editUrl);
  });

  test("a refused edit goes to the page its error path names", async () => {
    const pages = pagesFor(
      { editErrorPath: (id) => `/admin/holidays/${id}/rejected` },
      { update: refusedUpdate },
    );

    expectRedirect(await editAs(pages), "/admin/holidays/7/rejected");
  });

  test("a page with no edit route answers the edit POST with 404", async () => {
    const pages = pagesFor({ skip: ["edit"] });

    const response = await pages.editPost(mockRequest(editUrl), { id: 7 });

    expect(response.status).toBe(404);
  });

  test("a delete confirmation without a renderer shows an empty page", async () => {
    const cookie = await testCookie();
    const pages = pagesFor();

    const response = await pages.deleteGet(
      mockRequest("/admin/holidays/7/delete", { headers: { cookie } }),
      { id: 7 },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });
});
