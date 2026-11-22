/**
 * The steps that every test of an admin settings form shares: the owner logs
 * in, sends a form, and reads the page that the save leads to.
 */

import { expect } from "@std/expect";
import {
  type App,
  createApp,
  type Fields,
  inProcess,
  type Page,
} from "#test/blackbox/driver.ts";

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
