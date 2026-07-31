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

/** Whose browser each story keeps. The organiser's is the story's own, so a
 * step that does not say who is doing something is the organiser doing it. */
export const ORGANISER = "the organiser";
export const CUSTOMER = "the customer";
export const EDITOR = "the editor";
export const LATECOMER = "the latecomer";

/** Keep the window somebody is looking at, so the next step can read the page
 * they really ended on. */
export const rememberBrowser = (
  world: TicketsWorld,
  who: string,
  browser: TestBrowser,
): TestBrowser => world.things.remember("browser", who, browser);

/** The window somebody is already looking at. A story that never gave them one
 * has nothing to read, so it says so rather than opening a fresh window and
 * reporting on a page nobody was ever shown. */
export const browserSeenBy = (world: TicketsWorld, who: string): TestBrowser =>
  world.things.require("browser", who);

export const browserOf = (world: TicketsWorld, who: string): TestBrowser =>
  world.things.orMake("browser", who, () => new TestBrowser());

export const scenarioBrowser = (world: TicketsWorld): TestBrowser =>
  browserOf(world, ORGANISER);

/** Take a thing down from its own page: follow its delete link, type a name
 * to confirm, and keep what the site said for the story to read. Curried on
 * the page and the link, so each kind of thing declares itself in one line. */
export const takesDownFromOwnPage =
  (
    openPage: (world: TicketsWorld) => Promise<TestBrowser>,
    deleteLabel: string,
  ): ((world: TicketsWorld, typed: string) => Promise<void>) =>
  async (world: TicketsWorld, typed: string): Promise<void> => {
    const browser = await openPage(world);
    await browser.clickLink(deleteLabel);
    await fillInAndSend(browser, { confirm_identifier: typed }, deleteLabel);
    world.ownerTold = browser.pageText;
  };

/** Forget the Scenario's browser, so the next ask starts a fresh one. Use this
 * after the site itself is replaced and the old session can no longer work. */
export const resetScenarioBrowser = (world: TicketsWorld): void => {
  world.things.forget("browser", ORGANISER);
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

/** One read of a page: how the site answered, and what it said. */
export interface PageRead {
  answered: number;
  said: string;
}

/** What somebody who was never signed in is shown at an address, and how the
 * site answered. Both come from the one visit, so they always describe the page
 * the visitor really ended on rather than two separate answers. */
export const newcomerReading = async (path: string): Promise<PageRead> => {
  const browser = new TestBrowser();
  const answered = await browser.visit(path);
  return { answered, said: browser.pageText };
};

/** Opening the page one named thing is sold from, as somebody never signed in.
 * Where that page lives is the only part that differs between the things that
 * have one, so it is the only part passed. */
export type OpensASalesPage = (
  world: TicketsWorld,
  name: string,
) => Promise<TestBrowser>;

export const opensSalesPagesAt =
  (pathOf: (world: TicketsWorld, name: string) => string): OpensASalesPage =>
  (world, name) =>
    openAsNewcomer(pathOf(world, name));

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

/** The owner makes a record through a form, and the number the site filed it
 * under is kept by the story's name for it, ready for the steps that find it
 * again. The form, its button, and where the site lands afterwards are the
 * only parts that differ between the things made this way. */
export const makesRecordThroughForm =
  (labelled: { button: string; filedAt: RegExp; formPath: string }) =>
  async (
    world: TicketsWorld,
    name: string,
    fields: Record<string, string>,
  ): Promise<void> => {
    const browser = await openAdminPage(world, labelled.formPath);
    await fillInAndSend(browser, fields, labelled.button);
    world.ownerTold = browser.pageText;
    const id = browser.currentUrl.match(labelled.filedAt)?.[1];
    if (!id) throw new Error(`No page address for the new "${name}"`);
    world.things.remember("record", name, Number(id));
  };

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
