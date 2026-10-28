/** News posts: the owner writes and removes them, a visitor reads them. */

// jscpd:ignore-start

import {
  makesRecordThroughForm,
  openAsNewcomer,
  recordPageUnder,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

const makesPost = makesRecordThroughForm({
  button: "Create News Post",
  filedAt: /\/admin\/site\/news\/(\d+)\//,
  formPath: "/admin/site/news/new",
});

/** The owner writes a post and is left on its editor. */
export const ownerPostsNews = (
  world: TicketsWorld,
  name: string,
  words: string,
): Promise<void> => makesPost(world, name, { content: words, name });

/** The typed-name check behind the post's Actions tab; what the owner types
 * is the story's business. */
export const ownerTakesDownNews: TakesOneThingDown = takesDownFromList(
  recordPageUnder("/admin/site/news"),
  {
    deleteLinkKey: "news.delete_title",
    submitKey: "news.delete_submit",
  },
);

/** The news page as a visitor opens it, signed out, with the page kept so a
 * story can read both its words and its regions. */
export const visitorOnNewsPage = (): Promise<TestBrowser> =>
  openAsNewcomer("/news");

/** The post's own address, read off the news page's real link, so a post the
 * page stopped linking cannot be opened this way. */
type NewsLink = (name: string) => Promise<string>;

const newsLinkTo: NewsLink = async (name) => {
  const cards = (await visitorOnNewsPage()).currentHtml.matchAll(
    /<a[^>]*href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
  );
  // The link is found by the post's name, never by its place in the list.
  return requiredWorldValue(
    [...cards].find((card) => card[2]!.includes(name))?.[1],
    `the news page's link to "${name}"`,
  );
};

/** The post's page, opened the way a visitor opens it: by following the
 * post's own link off the news page. */
export const visitorFollowsNewsLink = async (
  name: string,
): Promise<TestBrowser> => openAsNewcomer(await newsLinkTo(name));

/** Whether a public page offers the News link in its navigation. */
export const newsLinkOfferedOnFrontPage = async (): Promise<boolean> => {
  const front = await openAsNewcomer("/");
  return front.currentHtml.includes('<a href="/news">');
};
