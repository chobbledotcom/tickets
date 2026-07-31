/**
 * News posts, as the owner writes them and a visitor reads them. The owner's
 * half drives the real admin forms; the visitor's half reads the public pages
 * signed out, because that is who the news is for.
 */

import {
  makesRecordThroughForm,
  newcomerReading,
  openAsNewcomer,
  type PageRead,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

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

/** The owner answers the type-the-name check behind the post's Actions tab.
 * What they typed is the story's business; both the wrong and the exact name
 * walk the same served pages. */
export const ownerTakesDownNews: TakesOneThingDown = takesDownFromList(
  (world, name) =>
    Promise.resolve(`/admin/site/news/${world.things.require("record", name)}`),
  {
    deleteLinkKey: "news.delete_title",
    missing: (name) => `The site filed no post under "${name}"`,
    submitKey: "news.delete_submit",
  },
);

/** What a visitor finds on the news page, signed out. */
export const visitorOnNewsPage = (): Promise<PageRead> =>
  newcomerReading("/news");

/** A visitor follows a post's own link from the news page and reads the page
 * it leads to. Following the served link is what keeps the story honest: a
 * post the news page stopped linking cannot be read this way. */
export const visitorFollowsNewsLink = async (
  name: string,
): Promise<PageRead> => {
  const browser = await openAsNewcomer("/news");
  const cards = browser.currentHtml.matchAll(
    /<a[^>]*href="(\/news\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
  );
  // The link is found by the post's name, never by its place in the list.
  const target = [...cards].find((card) => card[2]!.includes(name))?.[1];
  if (!target) {
    throw new Error(`The news page offers no link to a post named "${name}"`);
  }
  return newcomerReading(target);
};

/** Whether a public page offers the News link in its navigation. */
export const newsLinkOfferedOnFrontPage = async (): Promise<boolean> => {
  const front = await openAsNewcomer("/");
  return front.currentHtml.includes('<a href="/news">');
};
