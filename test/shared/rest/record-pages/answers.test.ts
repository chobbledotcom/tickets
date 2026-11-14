/**
 * The record page answers: the flash each write gives, the list and new
 * pages, the delete outcomes, and the paths the config overrides move.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { setFlashContext } from "#shared/flash-context.ts";
import { runWithRequestContext } from "#shared/request-context.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions/redirect.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  createAs,
  editAs,
  form,
  pagesFor,
  recordWith,
  refusedWrite,
  type Shape,
  toInput,
  type Values,
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

const missing = () => Promise.resolve({ kind: "not-found" as const });

describeWithEnv("the record page answers", { db: true }, () => {
  test("a create lands on the save page with a success flash", async () => {
    expectRedirectWithFlash(
      "/admin/holidays/9",
      "Widget created",
    )(await createAs(pagesFor()));
  });

  test("the flash names the singular the page declares", async () => {
    expectRedirectWithFlash(
      "/admin/holidays/9",
      "Gadget created",
    )(await createAs(pagesFor({ singular: "Gadget" })));
  });

  test("a refused create returns to the new page with its refusal", async () => {
    expectRedirectWithFlash(
      "/admin/holidays/new",
      "Nope",
      false,
    )(await createAs(pagesFor({}, { create: refusedWrite })));
  });

  test("a refused create goes to the error path the page names", async () => {
    const pages = pagesFor(
      { createErrorPath: "/admin/holidays" },
      { create: refusedWrite },
    );

    expectRedirectWithFlash(
      "/admin/holidays",
      "Nope",
      false,
    )(await createAs(pages));
  });

  test("a form refusal returns to the new page route the page names", async () => {
    const pages = pagesFor({
      routes: { new: "groupNew" },
      validateForm: () => "Fill it in",
    });

    expectRedirectWithFlash(
      "/admin/groups/new",
      "Fill it in",
      false,
    )(await createAs(pages));
  });

  test("a save path the page names moves the create landing", async () => {
    const pages = pagesFor({ savePath: (id) => `/admin/holidays/${id}/edit` });

    expectRedirectWithFlash(
      "/admin/holidays/9/edit",
      "Widget created",
    )(await createAs(pages));
  });

  test("an update lands on the save page with a success flash", async () => {
    expectRedirectWithFlash(
      "/admin/holidays/7",
      "Widget updated",
    )(await editAs(pagesFor()));
  });

  test("an update lands on the update save path when the page names one", async () => {
    const pages = pagesFor({
      savePath: () => "/admin/holidays",
      updateSavePath: (id) => `/admin/holidays/${id}/edit`,
    });

    expectRedirectWithFlash(
      "/admin/holidays/7/edit",
      "Widget updated",
    )(await editAs(pages));
  });

  test("an update of a vanished row answers 404", async () => {
    expect((await editAs(pagesFor({}, { update: missing }))).status).toBe(404);
  });

  test("a refused edit returns to the edit route the page names", async () => {
    const pages = pagesFor(
      { routes: { edit: "groupEdit" } },
      { update: refusedWrite },
    );

    expectRedirectWithFlash(
      "/admin/groups/7/edit",
      "Nope",
      false,
    )(await editAs(pages));
  });

  test("a surface with no edit page answers the edit POST with 404", async () => {
    const pages = recordPages<Shape, Values>(
      recordWith({}, { surface: "invoices" }),
      { form: form("Widget"), toInput },
    );

    expect((await editAs(pages)).status).toBe(404);
  });

  test("the list page renders the rows and the success flash", async () => {
    const seen: unknown[] = [];
    const pages = pagesFor({
      renderList: (rows, session, success) => {
        seen.push([rows, session.adminLevel, success]);
        return "list";
      },
    });
    const response = await withFlash("/admin/holidays", pages.listGet);

    expect([response.status, await response.text()]).toEqual([200, "list"]);
    expect(seen).toEqual([[[{ id: 7, name: "Widget" }], "owner", "Saved"]]);
  });

  test("a page with no list renderer answers the list with 404", async () => {
    const response = await pagesFor().listGet(await pageGet("/admin/holidays"));

    expect(response.status).toBe(404);
  });

  test("the new page renders the error flash", async () => {
    const seen: unknown[] = [];
    const pages = pagesFor({
      renderNew: (session, error) => {
        seen.push([session.adminLevel, error]);
        return "new";
      },
    });
    const response = await withFlash("/admin/holidays/new", pages.newGet);

    expect([response.status, await response.text()]).toEqual([200, "new"]);
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

  test("an override replaces the generated route", () => {
    const listGet = () => Promise.resolve(new Response("mine"));

    expect(pagesFor({ overrides: { listGet } }).listGet).toBe(listGet);
  });
});
