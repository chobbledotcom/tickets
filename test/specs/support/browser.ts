// jscpd:ignore-start

import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  type RowOnList,
  rowsOnList,
} from "#test/specs/support/form-controls/reading.ts";
import { expectCanReallySend } from "#test/specs/support/form-controls/rules.ts";
import {
  fillInAndSend,
  type SendingAForm,
  takeDownFromActions,
} from "#test/specs/support/form-controls.ts";
import { logInAsTestAdmin } from "#test-utils/e2e.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";
import {
  keepsAnswerAs,
  keepWhatTheyWereTold,
  type ReadAboutOneThing,
  type ReadsWhatWasKept,
  type StoryJourney,
  type TicketsWorld,
  whatWasKeptFor,
} from "./world.ts";
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
export const browserSeenBy: ReadsWhatWasKept<"browser"> =
  whatWasKeptFor("browser");

export const browserOf = (world: TicketsWorld, who: string): TestBrowser =>
  world.things.orMake("browser", who, () => new TestBrowser());

export const scenarioBrowser = (world: TicketsWorld): TestBrowser =>
  browserOf(world, ORGANISER);

/** What somebody fills in, worked out from the page they were actually served.
 * Reading the served page is what stops a story sending a value no real
 * browser could have offered. */
export type FillsInServedForm = (
  served: string,
) => Record<string, string | string[]>;

/** Filling in and saving the form on one named thing's own page, and being
 * handed whatever the caller needs to read afterwards. */
export type SavesNamedThingsForm<Answer> = (
  world: TicketsWorld,
  name: string,
  fillsIn: FillsInServedForm,
) => Promise<Answer>;

/** Save the form a page is showing, filled in from the markup it served, so a
 * story can never send a value the page did not offer. */
export const savesServedForm = (
  browser: TestBrowser,
  fillsIn: FillsInServedForm,
  buttonText = "Save Changes",
): Promise<void> =>
  browser.submitForm(fillsIn(browser.currentHtml), buttonText);

/** The site took the request. Handing the response back lets the caller read
 * whatever it came with. */
export const expectAccepted = (response: Response): Response => {
  expect(response.status).toBe(200);
  return response;
};

/** Take a window to an address and hand it back, so the caller reads the page
 * the visit really landed on. */
export const visiting = async (
  browser: TestBrowser,
  path: string,
): Promise<TestBrowser> => {
  await browser.visit(path);
  return browser;
};

/** The organiser sends a form on the admin page in front of them, and what
 * the site says back is kept for the story to read — the tail every one of
 * their actions ends in. */
/** Keep what the site said to the organiser in the window in front of them.
 * Every action of theirs ends here, so only this line knows that what they
 * were told is the text of the page they landed on. */
export const keepsWhatTheOrganiserSaw = (
  world: TicketsWorld,
  told: TestBrowser | string,
): void => {
  keepWhatTheyWereTold(
    world,
    ORGANISER,
    typeof told === "string" ? told : told.pageText,
  );
};

export const organiserSendsAndIsTold = async (
  world: TicketsWorld,
  browser: TestBrowser,
  ...sending: SendingAForm
): Promise<void> => {
  await fillInAndSend(browser, ...sending);
  keepsWhatTheOrganiserSaw(world, browser);
};

/** Where one page lives: an address that never changes, or one worked out
 * from the world and from whatever the story's own words named — a person, a
 * thing for sale, or nothing at all. */
export type PageAddress<Args extends unknown[] = []> =
  | string
  | ((world: TicketsWorld, ...args: Args) => string);

/** The address itself, whichever of the two ways the caller named it. */
const addressOf = <Args extends unknown[]>(
  where: PageAddress<Args>,
  world: TicketsWorld,
  ...args: Args
): string => (typeof where === "string" ? where : where(world, ...args));

/** The organiser opens one of their own pages and keeps what it said, so the
 * Then steps read the same page the When opened. Curried on which page,
 * because that is all that differs between one page of theirs and another.
 * A page whose address depends on who the story is talking about takes that
 * name too, so the step's own words decide which page is opened. */
export const organiserReads = <Args extends unknown[]>(
  where: PageAddress<Args>,
): StoryJourney<Args, void> =>
  keepsAnswerAs(ORGANISER, (world, ...args) =>
    adminPageHtmlAt(world, addressOf(where, world, ...args)),
  );

/** The organiser writes one message on a page and sends it, keeping what the
 * site said back. Curried on the page and the button, because those are all
 * that differ between writing to the host and texting somebody. */
export const writesOneMessage =
  <Args extends unknown[]>(
    where: PageAddress<Args>,
    button: () => string | Promise<string>,
  ): StoryJourney<[string, ...Args], void> =>
  async (world, message, ...args) => {
    const page = await openAdminPage(world, addressOf(where, world, ...args));
    await organiserSendsAndIsTold(world, page, { message }, await button());
  };

/** The organiser sends one particular form on one of their pages, and is left
 * with whatever the site said back. The form is chosen by where it posts,
 * because a settings page carries a dozen of them whose buttons all say Save
 * and no button's words can tell those apart. */
export const organiserSendsTheFormAt: SendingOnAPage<void> = async (
  world,
  path,
  action,
  values = {},
) => {
  const browser = await withAdminPage(world, path, async (page) => {
    // Picking the form by where it posts says a form goes there; it says
    // nothing about the boxes. Every value still has to be one that form
    // really offers, so a page that stopped offering a box fails here rather
    // than the send carrying a value no person could have typed.
    expectCanReallySend(page.formBodyAt(action), values);
    await page.submitFormAt(action, values);
    return page;
  });
  keepsWhatTheOrganiserSaw(world, browser);
};

/** The organiser presses one named button on a page, and is left with whatever
 * the site said back. The sibling of the helper above for pages whose forms
 * their buttons can tell apart. */
export const organiserPressesOnPage: SendingOnAPage<void> = async (
  world,
  path,
  buttonText,
  values = {},
) => {
  keepsWhatTheOrganiserSaw(
    world,
    await submitRenderedAdminForm(world, path, buttonText, values),
  );
};

/** Where one remembered record lives under an admin section. Every "take this
 * one down from the list" step resolves its address this way. */
export const recordPageUnder =
  (section: string) =>
  (world: TicketsWorld, name: string): Promise<string> =>
    Promise.resolve(`${section}/${world.things.require("record", name)}`);

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
    keepsWhatTheOrganiserSaw(world, browser);
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
export const openAsNewcomer = (path: string): Promise<TestBrowser> =>
  visiting(new TestBrowser(), path);

/** Somebody who was never signed in opens a page and sends the form on it.
 * The window they end on comes back, so the caller reads where the send took
 * them. */
export const newcomerSends = async (
  path: string,
  ...sending: SendingAForm
): Promise<TestBrowser> => {
  const browser = await openAsNewcomer(path);
  await fillInAndSend(browser, ...sending);
  return browser;
};

/** One read of a page: how the site answered, where the visitor ended up,
 * and what it said. */
export interface PageRead {
  answered: number;
  landedOn: string;
  said: string;
}

/** What somebody who was never signed in is shown at an address, and how the
 * site answered. Both come from the one visit, so they always describe the page
 * the visitor really ended on rather than two separate answers. */
export const newcomerReading = async (path: string): Promise<PageRead> => {
  const browser = new TestBrowser();
  const answered = await browser.visit(path);
  return { answered, landedOn: browser.currentUrl, said: browser.pageText };
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
  async (world, path) =>
    visiting(await whoseBrowser(world), path);

/** The organiser opens one of their own pages, signing in first if they are not
 * already. Every admin page a story reads starts here. */
export const openAdminPage: OpensAPage = opensPagesAs(adminBrowser);

/** The words on a page, read fresh each time it is asked for. Curried on the
 * way in, so "what X says" is one line wherever the page comes from. */
export const wordsOnPageFrom =
  (open: (world: TicketsWorld) => Promise<TestBrowser>) =>
  async (world: TicketsWorld): Promise<string> =>
    (await open(world)).pageText;

/** Somebody opens one page whose address never changes, and is handed the
 * window they are looking at it through. A caller that only needs the page
 * open can ignore what comes back. */
export type OpensOneFixedPage = (world: TicketsWorld) => Promise<TestBrowser>;

/** The organiser opens one page of their own, named once. Every "the owner
 * looks at X" step is this with a different address, so the address is the
 * only thing each caller says. An address that never changes is given as it
 * is; one worked out from the story so far is given as a `PageAddress`. The
 * window comes back for a caller that reads it, and a step that only needs
 * the page open can ignore it. */
export const opensAdminPageAt =
  (where: string | PageAddress<[]>): OpensOneFixedPage =>
  (world) =>
    openAdminPage(world, addressOf(where, world));

/** What one of the owner's own pages says right now. Opening and reading are
 * one step, so no caller can assert against a window it opened earlier. */
export const adminPageHtmlAt = async (
  world: TicketsWorld,
  path: string,
): Promise<string> => (await openAdminPage(world, path)).currentHtml;

/** The organiser opens one of their own pages, and something is done with
 * the window they are looking at — the opening every organiser action on a
 * page shares. Whatever the act works out comes back, so a caller that reads
 * the page hands its answer straight on. */
export const withAdminPage = async <Answer>(
  world: TicketsWorld,
  path: string,
  act: (browser: TestBrowser) => Promise<Answer>,
): Promise<Answer> => act(await openAdminPage(world, path));

/** Sending one form on one of the owner's pages: which page, which form —
 * named by where it posts or by the words on its button — and what to fill in.
 * The three senders differ only in how the form is picked and in what they
 * hand back, so the shape is written once. */
type SendingOnAPage<Answer> = (
  world: TicketsWorld,
  path: string,
  picked: string,
  values?: Record<string, string>,
) => Promise<Answer>;

export const submitRenderedAdminForm: SendingOnAPage<TestBrowser> = (
  world,
  path,
  buttonText,
  values = {},
) =>
  withAdminPage(world, path, async (browser) => {
    // Every value has to be one the page could really carry, so a form that
    // stopped offering a box fails here rather than the send going through
    // regardless.
    await fillInAndSend(browser, values, buttonText);
    return browser;
  });

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
type MakesARecord = (
  world: TicketsWorld,
  name: string,
  fields: Record<string, string>,
) => Promise<void>;

export const makesRecordThroughForm =
  (labelled: {
    button: string;
    filedAt: RegExp;
    formPath: string;
  }): MakesARecord =>
  async (world, name, fields) => {
    const browser = await openAdminPage(world, labelled.formPath);
    await fillInAndSend(browser, fields, labelled.button);
    keepWhatTheyWereTold(world, ORGANISER, browser.pageText);
    const id = browser.currentUrl.match(labelled.filedAt)?.[1];
    if (!id) throw new Error(`No page address for the new "${name}"`);
    world.things.remember("record", name, Number(id));
  };

/** A list open at one named row: the page somebody is looking at, and
 * everything that row says about the thing — its number, its own markup, and
 * the address of the link that names it. */
export type OpensAtOneRow = (
  world: TicketsWorld,
  name: string,
) => Promise<RowOnList & { browser: TestBrowser }>;

/** A list of the organiser's things, opened at one named row — or a loud
 * failure, because a story that carried on would act on the wrong row, or on
 * none. Each kind of thing says where its list lives and what the link into
 * one of its rows looks like; everything a story then reads or presses is
 * that row's own, never a neighbour's. */
export const opensListAtRow =
  (listPath: string, wayIn: RegExp): OpensAtOneRow =>
  async (world, name) => {
    const browser = await openAdminPage(world, listPath);
    const found = rowsOnList(browser.currentHtml, wayIn).find(
      (row) => row.name === name,
    );
    if (!found) throw new Error(`The list offers no row named "${name}"`);
    return { ...found, browser };
  };

/** The address of the link into one named row. The row is known by the link
 * that names it, so the way in is read off the row itself — a row whose way in
 * moved to a neighbour is a row the person cannot reach, and the open fails
 * with them. */
export const findsTheWayInFrom =
  (openAt: OpensAtOneRow): ReadAboutOneThing =>
  async (world, name) =>
    (await openAt(world, name)).wayIn;

export const takesDownFromList =
  (
    wayInto: ReadAboutOneThing,
    labelled: {
      deleteLinkKey: string;
      submitKey: string;
    },
  ): TakesOneThingDown =>
  async (world, name, typed) => {
    const wayIn = await wayInto(world, name);
    return takeDownFromActions(await openAdminPage(world, wayIn), typed, {
      deleteLink: t(labelled.deleteLinkKey),
      submit: t(labelled.submitKey),
    });
  };
