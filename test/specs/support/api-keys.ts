/**
 * A key the owner hands to another system so it can work on their behalf. The
 * other system's half sends the real request an outside caller would, carrying
 * the key and nothing else — no session, no cookie.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import { openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  type ActOnOneThing,
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { requestAsApiKey } from "#test-utils/session.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** The owner's own page listing the keys they have handed out. */
export const KEYS_PAGE = "/admin/api-keys";

/** What another system asks the site for. Reading back what is on sale is the
 * plainest thing a key is for, and needs nothing set up beyond a listing. */
const WHAT_THE_SITE_SELLS = "/api/admin/listings";

/** The owner's own page listing the keys they have handed out, open in front
 * of them. Everything the owner does with a key starts here, the way it would
 * for a real person. */
const openKeysPage = (world: TicketsWorld): Promise<TestBrowser> =>
  openAdminPage(world, KEYS_PAGE);

/** The owner opens their keys page, and it is theirs to read. */
export const ownerOpensKeys = async (world: TicketsWorld): Promise<void> => {
  await openKeysPage(world);
};

/** The owner makes a key, and the page hands it back once. Kept under the name
 * the story calls it, because that is all the owner will see from now on. */
export const ownerMakesKey: ActOnOneThing = async (world, name) => {
  const browser = await openKeysPage(world);
  await fillInAndSend(browser, { name }, t("api_keys.create_submit"));
  world.apiKeyShownOnce = browser.pageText;
  const shown = browser.pageText.match(/\b[A-Za-z0-9_-]{32,}\b/);
  if (!shown) throw new Error(`The owner was shown no ${name} key to copy`);
  world.apiKeys ??= new Map();
  world.apiKeys.set(name, shown[0]);
};

/** The key the story handed to one system. */
export const keyNamed = (world: TicketsWorld, name: string): string =>
  requiredWorldValue(world.apiKeys?.get(name), `the ${name} key`);

/** The owner's keys page as words on a screen, or as the whole response the
 * site sent. A key hidden in a link or an attribute is still a key anybody
 * reading the response can use, so "it is not shown" has to mean all of it. */
const readsKeysPage =
  (whichPart: (browser: TestBrowser) => string) =>
  async (world: TicketsWorld): Promise<string> =>
    whichPart(await openKeysPage(world));

export const keysPageText = readsKeysPage((browser) => browser.pageText);
export const keysPageResponse = readsKeysPage((browser) => browser.currentHtml);

/** What the site answers a caller asking what it sells, and what it said. */
export const askedWhatIsSold = async (
  carrying: string | null,
): Promise<{ answered: number; said: string }> => {
  const response = await handleRequest(
    carrying === null
      ? mockRequest(WHAT_THE_SITE_SELLS)
      : requestAsApiKey(WHAT_THE_SITE_SELLS, carrying),
  );
  return { answered: response.status, said: await response.text() };
};

/** A page the owner reads and clicks, by the word the story uses for it. */
const OWNER_PAGES: Record<string, string> = {
  keys: KEYS_PAGE,
  settings: "/admin/settings",
};

export const ownerPagePath = (page: string): string =>
  requiredWorldValue(OWNER_PAGES[page], `a page called "${page}"`);

/** What the site answers a key asking for one of the owner's own pages. */
export const askedForOwnerPage = async (
  carrying: string,
  page: string,
): Promise<number> => {
  const response = await handleRequest(
    requestAsApiKey(ownerPagePath(page), carrying),
  );
  return response.status;
};

/** The owner takes a key back, typing the name the page asks for. Keeps what
 * they were told, because typing it wrongly is meant to change nothing. */
export const ownerTakesBackKey = async (
  world: TicketsWorld,
  name: string,
  typed: string,
): Promise<string> => {
  const browser = await openKeysPage(world);
  // Followed from the list, so a key the owner cannot reach from their own
  // page cannot be taken back by the story either.
  const toKey = browser.links.find(({ href }) =>
    /^\/admin\/api-keys\/\d+$/.test(href),
  );
  if (!toKey) throw new Error(`The keys page offers no way into ${name}`);
  await browser.visit(`${toKey.href}/delete`);
  await fillInAndSend(
    browser,
    { confirm_identifier: typed },
    t("api_keys.delete_submit"),
  );
  return browser.pageText;
};

/** The story's own listing, so "it was told about the Pottery" means the site
 * really named it rather than answering with anything at all. */
export const expectToldAbout = (said: string, name: string): void => {
  expect(said).toContain(name);
};
