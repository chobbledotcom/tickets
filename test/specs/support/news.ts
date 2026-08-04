/** News posts: the owner writes and removes them, a visitor reads them. */

import {
  makesRecordThroughForm,
  newcomerReading,
  openAsNewcomer,
  type PageRead,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

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
  (world, name) =>
    Promise.resolve(`/admin/site/news/${world.things.require("record", name)}`),
  {
    deleteLinkKey: "news.delete_title",
    submitKey: "news.delete_submit",
  },
);

/** What a visitor finds on the news page, signed out. */
export const visitorOnNewsPage = (): Promise<PageRead> =>
  newcomerReading("/news");

/** Follow the post's own link off the news page, so a post the page stopped
 * linking cannot be read this way. */
export const visitorFollowsNewsLink = async (
  name: string,
): Promise<PageRead> => {
  const browser = await openAsNewcomer("/news");
  const cards = browser.currentHtml.matchAll(
    /<a[^>]*href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
  );
  // The link is found by the post's name, never by its place in the list.
  const target = requiredWorldValue(
    [...cards].find((card) => card[2]!.includes(name))?.[1],
    `the news page's link to "${name}"`,
  );
  return newcomerReading(target);
};

/** Whether a public page offers the News link in its navigation. */
export const newsLinkOfferedOnFrontPage = async (): Promise<boolean> => {
  const front = await openAsNewcomer("/");
  return front.currentHtml.includes('<a href="/news">');
};
