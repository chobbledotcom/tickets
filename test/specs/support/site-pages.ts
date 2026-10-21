/**
 * The pages a site has besides the things it sells. The visitor's half is
 * opened by somebody never signed in, because that is who these pages are for.
 */

import { expect } from "@std/expect";
import { sitePages } from "#db/site-pages.ts";
import { t } from "#i18n";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import {
  adminPageHtmlAt,
  findsTheWayInFrom,
  newcomerReading,
  openAdminPage,
  openAsNewcomer,
  opensListAtRow,
  type PageRead,
  type TakesOneThingDown,
  takesDownFromList,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  tickedCheckboxes,
} from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { movingRowsOn } from "#test/specs/support/reordering.ts";
import {
  type ActOnOneThing,
  type AsksAboutOneThing,
  keepsAnswerAs,
  keepWhatTheyWereTold,
  requiredWorldValue,
  type StoryJourney,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import {
  decodeEntities,
  findAllNavLinks,
} from "#test-utils/test-browser/parsing.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The owner's own list of the site's pages. */
const PAGES_LIST = "/admin/site/pages";

/** Whose reading of the site's own pages the story keeps: the owner writes
 * them, so the owner is who each answer was told to. */
const OWNER = "the owner";

/** Wording that appears on one page and nowhere else. Every page's name is in
 * the navigation on every page, so a check that only looked for the name would
 * pass against any page at all. Written as a sentence a visitor could really
 * be reading, because one of these stories leaves a page behind that is
 * published as a screenshot. */
export const wordsOnlyOn = (name: string): string =>
  `Everything this site has to say about ${name} is on this page.`;

/** The owner opens their list of pages, ready to write one. A page is no use
 * unless the public site is on, so a story that wrote one nobody could read
 * would prove nothing. */
export const ownerWritesPages = async (world: TicketsWorld): Promise<void> => {
  await enablePublicSite();
  await openAdminPage(world, PAGES_LIST);
};

/** The owner writes a page, choosing the address it lives at. Keeps what they
 * were told, because some of these are meant to be refused. The body defaults
 * to the page's own words; a story that puts something else in the editor
 * hands the body over. */
export const ownerWritesPage = (
  world: TicketsWorld,
  name: string,
  address: string,
  content: string = wordsOnlyOn(name),
): Promise<string> =>
  withAdminPage(world, PAGES_LIST, async (browser) => {
    await browser.clickLink(t("site.pages.add"));
    await fillInAndSend(
      browser,
      { content, name, slug: address },
      t("site.pages.create_submit"),
    );
    keepWhatTheyWereTold(world, OWNER, browser.pageText);
    // The address the owner chose, so a capture can open the page the way a
    // visitor would rather than being told the address a second time.
    leaveEvidencePage(world, ["page-anybody-can-read"], `/page/${address}`);
    return browser.pageText;
  });

/** The body a page carries when the owner put one library image in it: the
 * page's own words, then the image on its own line, in the short form the
 * editor writes when the owner chooses an image. The choosing itself is the
 * browser contract's journey; the story carries the body the choice writes. */
export const pageBodyWithImage = (
  name: string,
  image: string,
  id: number,
): string => `${wordsOnlyOn(name)}\n\n![${image}](img#${id})`;

/** What a visitor reading one of the site's own pages is shown. Opened by
 * somebody who was never signed in, because that is who these pages are for. */
export const visitorReading = (address: string): Promise<PageRead> =>
  newcomerReading(`/page/${address}`);

/** The content box the edit form serves for one page, read off the page's own
 * row. Reading the stored row instead would pass even if the form stopped
 * carrying the content, which is the thing the rule is about. */
export const reopenedPageContent = async (
  world: TicketsWorld,
  name: string,
): Promise<string> => {
  const wayIn = await linkIntoPage(world, name);
  const html = await adminPageHtmlAt(world, wayIn);
  const box = html.match(
    /<textarea\b[^>]*name="content"[^>]*>([\s\S]*?)<\/textarea>/i,
  );
  return decodeEntities(
    requiredWorldValue(box?.[1], `the content box on "${name}"'s edit page`),
  );
};

/** The owner's own list, open at one page's row — the row whose name links
 * into that page. A story that names a page the list does not show fails here
 * rather than moving the wrong page, or none. */
const openList = opensListAtRow(
  PAGES_LIST,
  new RegExp(`^${PAGES_LIST}/(\\d+)/edit$`),
);

/** The link into one page, read off that page's own row. A link, not any
 * mention of the path: a page whose row still has its reorder form but has
 * lost its way in is a page the owner cannot reach. */
const linkIntoPage = findsTheWayInFrom(openList);

/** The arrows the owner's own list offers for moving one page. */
const pageArrows = movingRowsOn(PAGES_LIST, openList);

/** The names of the site's pages in the order the owner is offered them, read
 * off their own list. Reading the stored rows instead would pass even if the
 * page rendered them in some other order, which is the thing the rule is
 * about. */
export const pagesInOrder = async (world: TicketsWorld): Promise<string[]> => {
  const browser = await openAdminPage(world, PAGES_LIST);
  const named = await sitePages.getAll();
  const shown = browser.pageText;
  return named
    .map(({ name }) => ({ at: shown.indexOf(name), name }))
    .filter(({ at }) => at >= 0)
    .sort((left, right) => left.at - right.at)
    .map(({ name }) => name);
};

/** The owner moves one page a step up the list. The arrows are pictures rather
 * than words, and every row has its own, so the story checks the list really
 * offers this page's arrow before pressing it. A page already at the top has no
 * up arrow at all, which is how the site says "no further". */
export const ownerMovesPageUp: ActOnOneThing = (world, name) =>
  pageArrows.move(world, name, "up");

/** Whether the owner's list offers to move one page up at all. A page already
 * at the top has no up arrow, which is how the site says "no further" — so
 * there is no request to send rather than one that quietly does nothing. */
export const pageIsOfferedAMoveUp: AsksAboutOneThing = (world, name) =>
  pageArrows.canMove(world, name, "up");

/** The owner takes a page down, typing a name to confirm. Keeps what they were
 * told, because typing it wrongly is meant to change nothing. */
export const ownerTakesPageDown: TakesOneThingDown = takesDownFromList(
  linkIntoPage,
  {
    deleteLinkKey: "site.pages.delete_title",
    submitKey: "site.pages.delete_submit",
  },
);

/** The owner tries to take a page down, and what they were told is kept for
 * the step that reads it back. */
export const ownerTriesToTakePageDown: StoryJourney<
  [name: string, typed: string],
  void
> = keepsAnswerAs(OWNER, ownerTakesPageDown);

/** What the owner was told the last time they wrote a page. */
export const whatOwnerWasTold = (world: TicketsWorld): string =>
  whatTheyWereTold(world, OWNER);

/** The name the page's Hidden box sends under: the form control the editor's
 * form carries for it. */
const HIDDEN_BOX = "hidden";

/** The owner opens one page's editor, by the way in from that page's own row
 * on their list. */
const openPageEditor = async (
  world: TicketsWorld,
  name: string,
): Promise<TestBrowser> =>
  openAdminPage(world, await linkIntoPage(world, name));

/** One page's own editor, open on the screen, with its Hidden box read off the
 * served form: the value ticking the box would send, and the boxes the page
 * shows ticked already. Both of the story's Hidden-box helpers read the page
 * this way, so a form that lost the box — or came back pre-ticked — fails
 * before any step acts on it. */
const editorServingHiddenBox = async (world: TicketsWorld, name: string) => {
  const browser = await openPageEditor(world, name);
  return {
    browser,
    tick: checkboxValueOffered(browser.currentHtml, HIDDEN_BOX),
    ticked: tickedCheckboxes(browser.currentHtml, HIDDEN_BOX),
  };
};

/** Both Hidden-box story actions open one page's own editor and read its box
 * through the same reader, so both carry this signature and nothing else is
 * shared between them. */
export type ActsOnAPagesHiddenBox = (
  world: TicketsWorld,
  name: string,
  hidden: boolean,
) => Promise<void>;

/** The owner ticks or clears the Hidden box on one page's own editor and
 * saves. The form's own values ride along the way a real browser sends them;
 * only the box is named, and an empty list for it is exactly the nothing a
 * browser sends for a cleared box. A tick is only a tick when the box started
 * clear, and a clear only when it started ticked, so a save that silently
 * dropped the box — or a form that came back pre-ticked — fails here. */
export const ownerSetsPageHidden: ActsOnAPagesHiddenBox = async (
  world,
  name,
  hidden,
) => {
  const { browser, tick, ticked } = await editorServingHiddenBox(world, name);
  if (hidden) expect(ticked).not.toContain(tick);
  else expect(ticked).toContain(tick);
  await fillInAndSend(browser, {}, t("common.save_changes"), {
    [HIDDEN_BOX]: hidden ? [tick] : [],
  });
  keepWhatTheyWereTold(world, OWNER, browser.pageText);
};

/** The page's editor comes back showing the Hidden box as the owner left it,
 * read off the form the editor serves rather than out of the stored row. */
export const pageEditorShowsHidden: ActsOnAPagesHiddenBox = async (
  world,
  name,
  hidden,
) => {
  const { tick, ticked } = await editorServingHiddenBox(world, name);
  expect(ticked).toEqual(hidden ? [tick] : []);
};

/** The address one of the owner's pages lives at, read from the site's own
 * record. A story names the page; the menu link to it carries the address. */
export const pageAddress = async (name: string): Promise<string> => {
  const page = (await sitePages.getAll()).find(
    ({ name: stored }) => stored === name,
  );
  if (!page) throw new Error(`The site has no page called "${name}"`);
  return page.slug;
};

/** Whether the menus on a public page offer one of the owner's pages, read
 * off the front page somebody never signed in opens. The links come from the
 * menus alone, so a page that only mentions the address in its own words is
 * not offered; and a menu link counts however its anchor is written. */
export const menusOfferPage = async (address: string): Promise<boolean> =>
  findAllNavLinks((await openAsNewcomer("/")).currentHtml).some(
    ({ href }) => href === `/page/${address}`,
  );
