/**
 * The pages a site has besides the things it sells. The visitor's half is
 * opened by somebody never signed in, because that is who these pages are for.
 */

import { t } from "#i18n";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { sitePages } from "#shared/db/site-pages.ts";
import {
  newcomerReading,
  openAdminPage,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  type ActOnOneThing,
  type AsksAboutOneThing,
  asksIfThereIs,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

/** The owner's own list of the site's pages. */
const PAGES_LIST = "/admin/site/pages";

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
export const ownerWritesPage = async (
  world: TicketsWorld,
  name: string,
  address: string,
): Promise<string> => {
  const browser = await openAdminPage(world, PAGES_LIST);
  await browser.clickLink(t("site.pages.add"));
  await fillInAndSend(
    browser,
    { content: wordsOnlyOn(name), name, slug: address },
    t("site.pages.create_submit"),
  );
  world.sitePageTold = browser.pageText;
  // The address the owner chose, so a capture can open the page the way a
  // visitor would rather than being told the address a second time.
  leaveEvidencePage(world, ["page-anybody-can-read"], `/page/${address}`);
  return browser.pageText;
};

/** What a visitor reading one of the site's own pages is shown. Opened by
 * somebody who was never signed in, because that is who these pages are for. */
export const visitorReading = (
  address: string,
): Promise<{ answered: number; said: string }> =>
  newcomerReading(`/page/${address}`);

/** The page the site has under this name, or a loud failure when it has none —
 * a story that carried on would move the wrong page, or none. */
const pageNamed = async (name: string) => {
  const rows = await sitePages.getAll();
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`The site has no page called ${name}`);
  return found;
};

/** The owner's own list, open, with one page's id to hand. Looking the page up
 * first means a story can never act on one the site does not have. */
const openList = async (
  world: TicketsWorld,
  name: string,
): Promise<{ browser: TestBrowser; id: number }> => {
  const { id } = await pageNamed(name);
  return { browser: await openAdminPage(world, PAGES_LIST), id };
};

/** What the owner's own list offers for one page, or nothing when it offers
 * none. Everything they do to a page is found here first, so a page missing
 * from their list cannot be acted on by the story either. */
const offeredForPage =
  <Extra extends unknown[]>(
    look: (browser: TestBrowser, id: number, ...extra: Extra) => string | null,
  ) =>
  async (
    world: TicketsWorld,
    name: string,
    ...extra: Extra
  ): Promise<string | null> => {
    const { browser, id } = await openList(world, name);
    return look(browser, id, ...extra);
  };

/** The link into one page from the owner's own list. A link, not any mention of
 * the path: a page whose row still has its reorder form but has lost its way in
 * is a page the owner cannot reach. */
const linkIntoPage = offeredForPage((browser, id) => {
  const into = new RegExp(`^${PAGES_LIST}/${id}(/edit)?$`);
  return browser.links.find(({ href }) => into.test(href))?.href ?? null;
});

/** One page's own move arrow on the owner's list. Its absence is how the site
 * says a page is already at the end, rather than failing. */
const moveArrowFor = offeredForPage((browser, id, direction: string) => {
  const arrow = `${PAGES_LIST}/${id}/move-${direction}`;
  return browser.currentHtml.includes(arrow) ? arrow : null;
});

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
export const ownerMovesPageUp: ActOnOneThing = async (world, name) => {
  const arrow = await moveArrowFor(world, name, "up");
  if (arrow) await adminFormPost(arrow, {});
};

/** Whether the owner's list offers to move one page up at all. A page already
 * at the top has no up arrow, which is how the site says "no further" — so
 * there is no request to send rather than one that quietly does nothing. */
export const pageIsOfferedAMoveUp: AsksAboutOneThing = asksIfThereIs(
  (world, name) => moveArrowFor(world, name, "up"),
);

/** The owner takes a page down, typing a name to confirm. Keeps what they were
 * told, because typing it wrongly is meant to change nothing. */
export const ownerTakesPageDown: TakesOneThingDown = takesDownFromList(
  linkIntoPage,
  {
    deleteLinkKey: "site.pages.delete_title",
    missing: (name) => `The list offers no way into ${name}`,
    submitKey: "site.pages.delete_submit",
  },
);

/** What the owner was told the last time they wrote a page. */
export const whatOwnerWasTold = (world: TicketsWorld): string =>
  requiredWorldValue(world.sitePageTold, "what the owner was told");
