/**
 * The record page answers: the flash each write gives, the list and new
 * pages, the delete outcomes, and the paths the config overrides move.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setFlashContext } from "#shared/flash-context.ts";
import { runWithRequestContext } from "#shared/request-context.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  createAs,
  editAs,
  form,
  type Input,
  pagesFor,
  pagesForRecord,
  refusedWrite,
  testLandings,
} from "#test-utils/record-pages.ts";
import { testCookie } from "#test-utils/session.ts";

/** A page GET from the test owner's session. */
const pageGet = async (path: string): Promise<Request> =>
  mockRequest(path, { headers: { cookie: await testCookie() } });

/** Run one page GET inside a request that carries both flash messages. */
const withFlash = async (
  path: string,
  route: (request: Request) => Promise<Response>,
): Promise<Response> => {
  const request = await pageGet(path);
  return runWithRequestContext(
    request,
    { clientIp: "127.0.0.1", locale: "en" },
    () => {
      setFlashContext({ error: "Bad", success: "Saved" });
      return route(request);
    },
  );
};

/** Render one page with both flash messages; the renderer answers the
 * route's own name, so the body proves which renderer ran. */
const expectFlashPage = async (
  path: string,
  route: "listGet" | "newGet",
  config: Parameters<typeof pagesFor>[0],
): Promise<void> => {
  const response = await withFlash(path, pagesFor(config)[route]);

  expect([response.status, await response.text()]).toEqual([200, route]);
};

const missing = () => Promise.resolve({ kind: "not-found" as const });

const refused = { create: refusedWrite, update: refusedWrite };

const created = { act: createAs, succeeded: true };
const refusedCreate = { act: createAs, succeeded: false, write: refused };
const updated = { act: editAs, succeeded: true };
const refusedEdit = { act: editAs, succeeded: false, write: refused };

describeWithEnv("the record page answers", { db: true }, () => {
  testLandings(created, {
    "a create lands on the save page with a success flash": [
      {},
      "/admin/holidays/9",
      "Widget created",
    ],
    "a save path the page names moves the create landing": [
      { savePath: (id) => `/admin/holidays/${id}/edit` },
      "/admin/holidays/9/edit",
      "Widget created",
    ],
    "an empty save path is kept, not replaced by the record page": [
      { savePath: () => "" },
      "/",
      "Widget created",
    ],
    "an empty singular stays empty in the flash": [
      { singular: "" },
      "/admin/holidays/9",
      " created",
    ],
    "the flash names the singular the page declares": [
      { singular: "Gadget" },
      "/admin/holidays/9",
      "Gadget created",
    ],
  });

  testLandings(refusedCreate, {
    "a form refusal returns to the new page route the page names": [
      { routes: { new: "groupNew" }, validateForm: () => "Fill it in" },
      "/admin/groups/new",
      "Fill it in",
    ],
    "a refused create goes to the error path the page names": [
      { createErrorPath: "/admin/holidays" },
      "/admin/holidays",
      "Nope",
    ],
    "a refused create returns to the new page with its refusal": [
      {},
      "/admin/holidays/new",
      "Nope",
    ],
    "an empty error path is kept, not replaced by the new page": [
      { createErrorPath: "" },
      "/",
      "Nope",
    ],
  });

  testLandings(updated, {
    "an update lands on the save page with a success flash": [
      {},
      "/admin/holidays/7",
      "Widget updated",
    ],
    "an update lands on the update save path when the page names one": [
      {
        savePath: () => "/admin/holidays",
        updateSavePath: (id) => `/admin/holidays/${id}/edit`,
      },
      "/admin/holidays/7/edit",
      "Widget updated",
    ],
  });

  testLandings(refusedEdit, {
    "a refused edit returns to the edit route the page names": [
      { routes: { edit: "groupEdit" } },
      "/admin/groups/7/edit",
      "Nope",
    ],
    "an empty edit error path is kept, not replaced by the edit page": [
      { editErrorPath: () => "" },
      "/",
      "Nope",
    ],
  });

  test("an update of a vanished row answers 404", async () => {
    expect((await editAs(pagesFor({}, { update: missing }))).status).toBe(404);
  });

  test("a surface with no edit page answers the edit POST with 404", async () => {
    const pages = pagesForRecord({ surface: "invoices" });

    expect((await editAs(pages)).status).toBe(404);
  });

  test("the list page renders the rows and the success flash", async () => {
    const seen: unknown[] = [];
    await expectFlashPage("/admin/holidays", "listGet", {
      renderList: (rows, session, success) => {
        seen.push([rows, session.adminLevel, success]);
        return "listGet";
      },
    });

    expect(seen).toEqual([[[{ id: 7, name: "Widget" }], "owner", "Saved"]]);
  });

  test("a page with no list renderer answers the list with 404", async () => {
    const response = await pagesFor().listGet(await pageGet("/admin/holidays"));

    expect(response.status).toBe(404);
  });

  test("the new page renders the error flash", async () => {
    const seen: unknown[] = [];
    await expectFlashPage("/admin/holidays/new", "newGet", {
      renderNew: (session, error) => {
        seen.push([session.adminLevel, error]);
        return "newGet";
      },
    });

    expect(seen).toEqual([["owner", "Bad"]]);
  });

  test("a skipped new route answers 404 even with a renderer", async () => {
    const pages = pagesFor({ renderNew: () => "new", skip: ["new"] });

    const response = await pages.newGet(await pageGet("/admin/holidays/new"));

    expect(response.status).toBe(404);
  });

  test("a page with no new renderer answers the new page with 404", async () => {
    const response = await pagesFor().newGet(
      await pageGet("/admin/holidays/new"),
    );

    expect(response.status).toBe(404);
  });

  test("a create parses the create form, not the edit form", async () => {
    const created: Input[] = [];
    const pages = pagesFor(
      { editForm: form("Edited name"), form: form("Created name") },
      {
        create: (input) => {
          created.push(input);
          return Promise.resolve({ kind: "written", row: { id: 9, ...input } });
        },
      },
    );

    await createAs(pages);

    expect(created).toEqual([{ name: "Created name" }]);
  });

  test("an override replaces the generated route", () => {
    const listGet = () => Promise.resolve(new Response("mine"));

    expect(pagesFor({ overrides: { listGet } }).listGet).toBe(listGet);
  });
});
