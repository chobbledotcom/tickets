/**
 * The pages a site has besides the things it sells. The visitor's half is
 * opened by somebody never signed in, because that is who these pages are for.
 */

import { sitePages } from "#db/site-pages.ts";
import { t } from "#i18n";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import {
  findsTheWayInFrom,
  newcomerReading,
  openAdminPage,
  opensListAtRow,
  type PageRead,
  type TakesOneThingDown,
  takesDownFromList,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { movingRowsOn } from "#test/specs/support/reordering.ts";
import {
  type ActOnOneThing,
  type AsksAboutOneThing,
  keepsAnswerAs,
  keepWhatTheyWereTold,
  type StoryJourney,
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

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
 * were told, because some of these are meant to be refused. */
export const ownerWritesPage = (
  world: TicketsWorld,
  name: string,
  address: string,
): Promise<string> =>
  withAdminPage(world, PAGES_LIST, async (browser) => {
    await browser.clickLink(t("site.pages.add"));
    await fillInAndSend(
      browser,
      { content: wordsOnlyOn(name), name, slug: address },
      t("site.pages.create_submit"),
    );
    keepWhatTheyWereTold(world, OWNER, browser.pageText);
    // The address the owner chose, so a capture can open the page the way a
    // visitor would rather than being told the address a second time.
    leaveEvidencePage(world, ["page-anybody-can-read"], `/page/${address}`);
    return browser.pageText;
  });

/** What a visitor reading one of the site's own pages is shown. Opened by
 * somebody who was never signed in, because that is who these pages are for. */
export const visitorReading = (address: string): Promise<PageRead> =>
  newcomerReading(`/page/${address}`);

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
