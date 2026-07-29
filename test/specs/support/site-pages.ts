/**
 * The pages a site has besides the things it sells. The visitor's half is
 * opened by somebody never signed in, because that is who these pages are for.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { t } from "#i18n";
import { sitePages } from "#shared/db/site-pages.ts";
import { openAdminPage, openAsNewcomer } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  type ActOnOneThing,
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
 * pass against any page at all. */
export const wordsOnlyOn = (name: string): string =>
  `The body of ${name}, and of nothing else.`;

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
  return browser.pageText;
};

/** What a visitor reading an address is shown, and whether it answered at all.
 * Opened by somebody who was never signed in, because that is who these pages
 * are for. */
export const visitorReading = async (
  address: string,
): Promise<{ answered: number; said: string }> => {
  const browser = await openAsNewcomer("/");
  const answered = await browser.statusOf(`/page/${address}`);
  if (answered !== 200) return { answered, said: "" };
  await browser.visit(`/page/${address}`);
  return { answered, said: browser.pageText };
};

/** The page the site has under this name, or a loud failure when it has none —
 * a story that carried on would move the wrong page, or none. */
const pageNamed = async (name: string) => {
  const rows = await sitePages.getAll();
  const found = rows.find((row) => row.name === name);
  if (!found) throw new Error(`The site has no page called ${name}`);
  return found;
};

/** An admin page about one of the site's pages, with that page's id to hand.
 * Looking the page up first means a story can never act on one the site does
 * not have. */
const openAbout = async (
  world: TicketsWorld,
  name: string,
  where: string | ((id: number) => string),
): Promise<{ browser: TestBrowser; id: number }> => {
  const { id } = await pageNamed(name);
  const path = typeof where === "string" ? where : where(id);
  return { browser: await openAdminPage(world, path), id };
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
    const { browser, id } = await openAbout(world, name, PAGES_LIST);
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

/** The owner takes a page down, typing its name to confirm. */
export const ownerTakesPageDown: ActOnOneThing = async (world, name) => {
  const toPage = await linkIntoPage(world, name);
  if (!toPage) throw new Error(`The list offers no way into ${name}`);
  const browser = await openAdminPage(world, toPage);
  // The delete link lives behind the page's own Actions tab, which is where an
  // owner would find it.
  await browser.clickLink("Actions");
  await browser.clickLink(t("site.pages.delete_title"));
  await fillInAndSend(
    browser,
    { confirm_identifier: name },
    t("site.pages.delete_submit"),
  );
  expect(browser.containsText(t("site.pages.deleted"))).toBe(true);
};

/** What the owner was told the last time they wrote a page. */
export const whatOwnerWasTold = (world: TicketsWorld): string =>
  requiredWorldValue(world.sitePageTold, "what the owner was told");
