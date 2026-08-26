/**
 * A key the owner hands to another system so it can work on their behalf. The
 * other system's half sends the real request an outside caller would, carrying
 * the key and nothing else — no session, no cookie.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { t } from "#i18n";
import { handleRequest } from "#routes";
import {
  findsTheWayInFrom,
  opensAdminPageAt,
  opensListAtRow,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
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
const KEYS_PAGE = "/admin/api-keys";

/** A link into one key from the owner's own list. */
const KEY_LINK = /^\/admin\/api-keys\/(\d+)$/;

/** What another system asks the site for. Reading back what is on sale is the
 * plainest thing a key is for, and needs nothing set up beyond a listing. */
const WHAT_THE_SITE_SELLS = "/api/admin/listings";

/** The owner's own page listing the keys they have handed out, open in front
 * of them. Everything the owner does with a key starts here, the way it would
 * for a real person. */
const openKeysPage = opensAdminPageAt(KEYS_PAGE);

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
  // The code block the page hands the key back in. Taking the first long word
  // on the page instead would pick up any other token rendered above it, and
  // the story would carry on with something that is not a key at all.
  const shown = browser.currentHtml.match(
    /<pre><code>([A-Za-z0-9_-]+)<\/code><\/pre>/,
  );
  if (!shown) throw new Error(`The owner was shown no ${name} key to copy`);
  world.things.remember("key", name, shown[1]!);
};

/** The key the story handed to one system. */
export const keyNamed = (world: TicketsWorld, name: string): string =>
  world.things.require("key", name);

/** The owner's keys page as words on a screen, or as the whole response the
 * site sent. A key hidden in a link or an attribute is still a key anybody
 * reading the response can use, so "it is not shown" has to mean all of it. */
type ReadKeysPage = (world: TicketsWorld) => Promise<string>;

const readsKeysPage =
  (whichPart: (browser: TestBrowser) => string) =>
  async (world: TicketsWorld): Promise<string> =>
    whichPart(await openKeysPage(world));

export const keysPageText: ReadKeysPage = readsKeysPage(
  (browser) => browser.pageText,
);
export const keysPageResponse: ReadKeysPage = readsKeysPage(
  (browser) => browser.currentHtml,
);

/** The names the owner's list offers, each one a link into that key. Reading
 * the links rather than the words means a name only mentioned in passing does
 * not count as a key the owner has. */
export const keysNamedOnList = async (world: TicketsWorld): Promise<string[]> =>
  (await openKeysPage(world)).links
    .filter(({ href }) => KEY_LINK.test(href))
    .map(({ text }) => text);

/** What the site answers something carrying a key and nothing else — no
 * session, no cookie. Every request another system makes goes through here. */
const askedAsKey = (
  carrying: string,
  path: string,
  sending: RequestInit = {},
): Promise<Response> => handleRequest(requestAsApiKey(path, carrying, sending));

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

/** Another system puts something new on sale, carrying only its key. A write
 * is a different path from a read — it is the one that could start demanding a
 * cookie nobody holding a key has — so the story sends one. */
export const keyAddsSomethingForSale = async (
  carrying: string,
  name: string,
): Promise<number> =>
  (
    await askedAsKey(carrying, WHAT_THE_SITE_SELLS, {
      body: JSON.stringify({ max_attendees: 10, name }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  ).status;

/** A page the owner reads and clicks, by the word the story uses for it. */
const OWNER_PAGES: Record<string, string> = {
  docs: `${KEYS_PAGE}/docs`,
  keys: KEYS_PAGE,
  settings: "/admin/settings",
};

const ownerPagePath = (page: string): string =>
  requiredWorldValue(OWNER_PAGES[page], `a page called "${page}"`);

/** What the site answers a key at one of the owner's own pages. Reading a page
 * and sending its form are different doors, and a key that could not open the
 * first but could push through the second would be worse — that is where
 * settings are changed and more keys are made — so the story tries both. */
type AsksForOwnerPage = (carrying: string, page: string) => Promise<number>;

const asksForOwnerPage =
  (sending: RequestInit): AsksForOwnerPage =>
  async (carrying, page) =>
    (await askedAsKey(carrying, ownerPagePath(page), sending)).status;

export const askedForOwnerPage: AsksForOwnerPage = asksForOwnerPage({});
export const askedToSendOwnerForm: AsksForOwnerPage = asksForOwnerPage({
  body: new URLSearchParams({ name: "Sneaked in" }),
  method: "POST",
});

/** The owner takes a key back, typing the name the page asks for. The key is
 * found on its own row of the owner's list, by the name they gave it, so a
 * list of several takes back the right one. Keeps what they were told, because
 * typing it wrongly is meant to change nothing. */
export const ownerTakesBackKey: TakesOneThingDown = takesDownFromList(
  findsTheWayInFrom(opensListAtRow(KEYS_PAGE, KEY_LINK)),
  {
    deleteLinkKey: "api_keys.delete_submit",
    submitKey: "api_keys.delete_submit",
  },
);

/** The story's own listing, so "it was told about the Pottery" means the site
 * really named it rather than answering with anything at all. */
export const expectToldAbout = (said: string, name: string): void => {
  expect(said).toContain(name);
};
