/**
 * The steps that every test of an admin settings form shares: the owner logs
 * in, sends a form, and reads the page that the save leads to.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type App,
  createApp,
  type Fields,
  inProcess,
  type Page,
} from "#test/blackbox/driver.ts";
import { decodeEntities } from "#test-utils/test-browser/parsing.ts";

/** One settings form: where it shows, and where it sends. */
export interface SettingsForm {
  action: string;
  field: string;
  page: string;
}

export const loggedIn = async (): Promise<App> => {
  const app = createApp(inProcess);
  await app.logIn();
  return app;
};

/** The owner sends the form from its page with these fields. */
export const send = (
  app: App,
  form: SettingsForm,
  fields: Fields,
): Promise<Page> => app.submit(form.page, fields, form.action);

/** The address that a save redirects to. */
export const redirectOf = (sent: Page): string => {
  expect(sent.status).toBe(302);
  if (sent.location === null) throw new Error("The save named no address.");
  return sent.location;
};

/** The page that a save redirects to, where its message shows. */
export const followed = (app: App, sent: Page): Promise<Page> =>
  app.get(redirectOf(sent));

/** The form sent with a token that the page did not give. */
export const sendWithWrongToken = (
  app: App,
  form: SettingsForm,
  value: string,
): Promise<Page> =>
  send(app, form, { csrfToken: "invalid-csrf-token", [form.field]: value });

/** The answer to the form sent by a visitor who is not logged in. */
export const sendLoggedOut = (
  form: SettingsForm,
  value: string,
): Promise<Response> =>
  inProcess(
    new Request(`http://localhost${form.action}`, {
      body: new URLSearchParams({ [form.field]: value }).toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        host: "localhost",
        origin: "http://localhost",
      },
      method: "POST",
    }),
  );

/** The page after the owner sends the form with these fields and follows the
 * redirect. The message of the save shows on it. */
export const pageAfter = async (
  app: App,
  form: Pick<SettingsForm, "action" | "page">,
  fields: Fields,
): Promise<string> =>
  (await followed(app, await app.submit(form.page, fields, form.action))).html;

export const activityLog = async (app: App): Promise<string> =>
  (await app.get("/admin/log")).html;

/** The text that the page holds in the box named `field`. */
export const boxText = (html: string, field: string): string => {
  const area = html.match(
    new RegExp(`<textarea\\b[^>]*name="${field}"[^>]*>([\\s\\S]*?)</textarea>`),
  );
  if (area !== null) return decodeEntities((area[1] ?? "").replace(/^\n/, ""));
  const input = html.match(new RegExp(`<input\\b[^>]*name="${field}"[^>]*>`));
  if (input === null) throw new Error(`The page shows no box "${field}".`);
  return decodeEntities(input[0].match(/\svalue="([^"]*)"/)?.[1] ?? "");
};

/** The input tags of `html` named `field`. */
export const inputsNamed = (html: string, field: string): string[] =>
  (html.match(/<input\b[^>]*>/gi) ?? []).filter((tag) =>
    tag.includes(`name="${field}"`),
  );

export const isTicked = (tag: string): boolean =>
  /\schecked(?=[\s>=/])/.test(tag);

/** Whether the page shows the one box named `field` as ticked. */
export const boxTicked = (html: string, field: string): boolean => {
  const [box, ...more] = inputsNamed(html, field);
  if (box === undefined || more.length > 0) {
    throw new Error(`The page does not show one box for "${field}".`);
  }
  return isTicked(box);
};

/** The two tests that every settings form owes: a wrong token and a visitor
 * who is not logged in both change nothing. `shown` reads the saved value
 * from the page of the form, and `start` is the value of a new site. `owner`
 * logs in, and first does what the page needs to show the form. */
export const testFormGuards = (
  form: SettingsForm,
  value: string,
  shown: (app: App) => Promise<unknown>,
  start: unknown,
  owner: () => Promise<App> = loggedIn,
): void => {
  test("a form with a wrong token is refused and changes nothing", async () => {
    const app = await owner();
    const refused = await sendWithWrongToken(app, form, value);
    expect(refused.status).toBe(403);
    expect(refused.html).toContain("Invalid CSRF token");
    expect(await shown(app)).toEqual(start);
  });

  test("a visitor who is not logged in is sent to the login and changes nothing", async () => {
    const response = await sendLoggedOut(form, value);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
    expect(await shown(await owner())).toEqual(start);
  });
};
