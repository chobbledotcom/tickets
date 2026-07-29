// jscpd:ignore-start
import { t } from "#i18n";
import {
  fillInAndSend,
  takeDownFromActions,
} from "#test/specs/support/form-controls.ts";
import { logInAsTestAdmin } from "#test-utils/e2e.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import type { TicketsWorld } from "./world.ts";
// jscpd:ignore-end

export const scenarioBrowser = (world: TicketsWorld): TestBrowser => {
  world.testBrowser ??= new TestBrowser();
  return world.testBrowser;
};

/** Forget the Scenario's browser, so the next ask starts a fresh one. Use this
 * after the site itself is replaced and the old session can no longer work. */
export const resetScenarioBrowser = (world: TicketsWorld): void => {
  delete world.testBrowser;
};

export const adminBrowser = async (
  world: TicketsWorld,
): Promise<TestBrowser> => {
  const browser = scenarioBrowser(world);
  await browser.visit("/admin/");
  if (browser.containsText("Login")) await logInAsTestAdmin(browser);
  return browser;
};

/** Somebody who has not been here before opens a page — a customer following a
 * link, or a person opening an invite they were sent. */
export const openAsNewcomer = async (path: string): Promise<TestBrowser> => {
  const browser = new TestBrowser();
  await browser.visit(path);
  return browser;
};

/** Opening any page as one particular person, and being handed the browser
 * they are looking at it through. */
export type OpensAPage = (
  world: TicketsWorld,
  path: string,
) => Promise<TestBrowser>;

/** Opening a page as one particular person. Give it whose browser to use and
 * it hands back a way to open any page as them, so "the organiser opens X" and
 * "the editor opens X" are the same thing with a different person in it. */
export const opensPagesAs =
  (
    whoseBrowser: (world: TicketsWorld) => TestBrowser | Promise<TestBrowser>,
  ): OpensAPage =>
  async (world, path) => {
    const browser = await whoseBrowser(world);
    await browser.visit(path);
    return browser;
  };

/** The organiser opens one of their own pages, signing in first if they are not
 * already. Every admin page a story reads starts here. */
export const openAdminPage: OpensAPage = opensPagesAs(adminBrowser);

export const submitRenderedAdminForm = async (
  world: TicketsWorld,
  path: string,
  buttonText: string,
  values: Record<string, string> = {},
): Promise<TestBrowser> => {
  const browser = await openAdminPage(world, path);
  // Every value has to be one the page could really carry, so a form that
  // stopped offering a box fails here rather than the send going through
  // regardless.
  await fillInAndSend(browser, values, buttonText);
  return browser;
};

/** Somebody takes one thing down, typing a name to confirm, and is told what
 * the site said. Every way in is followed rather than built — the link on the
 * list, then the delete link behind that page's Actions tab — so a thing the
 * site stopped offering a way into is one the story cannot take down either. */
export type TakesOneThingDown = (
  world: TicketsWorld,
  name: string,
  typed: string,
) => Promise<string>;

export const takesDownFromList =
  (
    wayInto: (world: TicketsWorld, name: string) => Promise<string | null>,
    labelled: {
      deleteLinkKey: string;
      missing: (name: string) => string;
      submitKey: string;
    },
  ): TakesOneThingDown =>
  async (world, name, typed) => {
    const wayIn = await wayInto(world, name);
    if (!wayIn) throw new Error(labelled.missing(name));
    return takeDownFromActions(await openAdminPage(world, wayIn), typed, {
      deleteLink: t(labelled.deleteLinkKey),
      submit: t(labelled.submitKey),
    });
  };
