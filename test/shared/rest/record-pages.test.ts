/**
 * Direct unit tests for the record page routes: the parse step, the edit
 * refusal answers, the skipped-route guards, and the default delete render.
 * The integration suites drive the same pages through real routes; these
 * mirror the branches a single record's fake supplies.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { recordPages } from "#shared/rest/record-pages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  createAs,
  editAs,
  editUrl,
  expectRedirect,
  form,
  type Input,
  type PagesConfig,
  pagesFor,
  recordWith,
  refusedWrite,
  type Shape,
  toInput,
  type Values,
} from "#test-utils/record-pages.ts";
import { testCookie } from "#test-utils/session.ts";

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

  test("an edit hands the record the plan its form names, or none", async () => {
    const plan = { persist: () => Promise.resolve() };
    const planned: unknown[] = [];
    const record = recordWith();
    using _update = stub(record, "update", (_id, _input, given) => {
      planned.push(given);
      return Promise.resolve({ kind: "written", row: { id: 7, name: "W" } });
    });
    const pagesWith = (config: Partial<PagesConfig>) =>
      recordPages(record, { form: form("Widget"), toInput, ...config });

    await editAs(pagesWith({ editPlan: () => Promise.resolve(plan) }));
    await editAs(pagesWith({}));

    expect(planned).toEqual([plan, undefined]);
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
      { update: refusedWrite },
    );

    const response = await editAs(pages);

    expect(calls).toEqual([[7, "Nope"]]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("panel");
  });

  test("a refused edit without a renderer redirects to its edit page", async () => {
    const pages = pagesFor({}, { update: refusedWrite });

    expectRedirect(await editAs(pages), editUrl);
  });

  test("a refused edit goes to the page its error path names", async () => {
    const pages = pagesFor(
      { editErrorPath: (id) => `/admin/holidays/${id}/rejected` },
      { update: refusedWrite },
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
