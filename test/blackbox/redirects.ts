/**
 * The steps that every redirect test shares: the owner adds and deletes
 * redirects on the redirect pages, a visitor asks for a page, and the advanced
 * settings page says how many redirects exist.
 */

import { expect } from "@std/expect";
import {
  type App,
  createApp,
  inProcess,
  type Page,
} from "#test/blackbox/driver.ts";
import { followed } from "#test/blackbox/settings.ts";
import { decodeEntities } from "#test-utils/test-browser/parsing.ts";

export const LIST = "/admin/redirects";

/** The owner adds one redirect through the add page, and the page that the
 *  save lands on. */
export const addRedirect = async (
  app: App,
  fromPath: string,
  toUrl: string,
): Promise<Page> =>
  followed(app, await app.submit(`${LIST}/new`, { fromPath, toUrl }, LIST));

/** The text of the error that a refused add shows on the add page. */
export const refusalOf = (page: Page): string => {
  expect(page.status).toBe(200);
  const error = page.html.match(/<div [^>]*class="error"[^>]*>([^<]*)<\/div>/);
  expect(error).not.toBeNull();
  return decodeEntities(error![1]!);
};

/** The rows of the redirect list: each from page with its to page. */
export const listedRedirects = async (
  app: App,
): Promise<[string, string][]> => {
  const html = (await app.get(LIST)).html;
  return [...html.matchAll(/<tr><td>([^<]*)<\/td><td>([^<]*)<\/td>/g)].map(
    ([, from, to]) => [decodeEntities(from!), decodeEntities(to!)],
  );
};

/** The number that the advanced settings page says. */
export const countShown = async (app: App): Promise<string> => {
  const html = (await app.get("/admin/settings-advanced")).html;
  const said = html.match(/You have ([^<]*) set up\./);
  expect(said).not.toBeNull();
  return said![1]!;
};

/** The id of the redirect that leaves `fromPath`, read off its delete link in
 *  the list. */
export const idOf = async (app: App, fromPath: string): Promise<number> => {
  const rows = await listedRedirects(app);
  const at = rows.findIndex(([from]) => from === fromPath);
  expect(at).toBeGreaterThanOrEqual(0);
  const ids = [
    ...(await app.get(LIST)).html.matchAll(
      /\/admin\/redirects\/(\d+)\/delete/g,
    ),
  ];
  return Number(ids[at]![1]);
};

/** A visitor with no cookies asks for a page, as a browser does. */
export const visit = (path: string, method = "GET"): Promise<Response> =>
  inProcess(
    new Request(`http://localhost${path}`, {
      headers: { host: "localhost" },
      method,
      redirect: "manual",
    }),
  );

/** The owner logs in and adds each redirect, as [from page, to page]. */
export const shopWith = async (
  ...redirects: readonly (readonly [string, string])[]
): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  for (const [from, to] of redirects) await addRedirect(app, from, to);
  return app;
};

/** Where a visitor to `path` is sent: the status and the location. */
export const sentFrom = async (
  path: string,
  method = "GET",
): Promise<[number, string | null]> => {
  const answer = await visit(path, method);
  return [answer.status, answer.headers.get("location")];
};

/** The owner sends the delete form of the redirect that leaves `from`. */
export const deleteRedirect = async (
  app: App,
  from: string,
  confirm = from,
): Promise<Page> =>
  app.submit(`${LIST}/${await idOf(app, from)}/delete`, {
    confirmIdentifier: confirm,
  });
