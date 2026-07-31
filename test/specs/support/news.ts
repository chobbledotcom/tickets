/**
 * News posts, as the owner writes them and a visitor reads them. The owner's
 * half drives the real admin forms; the visitor's half reads the public pages
 * signed out, because that is who the news is for.
 */

import {
  newcomerReading,
  openAdminPage,
  openAsNewcomer,
  type PageRead,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

/** The owner writes a post and is left on its editor. The number the site
 * files the post under is kept by its name, so a later step can find the
 * same post again. */
export const ownerPostsNews = async (
  world: TicketsWorld,
  name: string,
  words: string,
): Promise<void> => {
  const browser = await openAdminPage(world, "/admin/site/news/new");
  await fillInAndSend(browser, { content: words, name }, "Create News Post");
  world.ownerTold = browser.pageText;
  const id = browser.currentUrl.match(/\/admin\/site\/news\/(\d+)\//)?.[1];
  if (!id) throw new Error(`No post editor address after creating "${name}"`);
  world.things.remember("record", name, Number(id));
};

/** The owner answers the type-the-name check on a post's delete page. What
 * they typed is the story's business; both the wrong and the exact name go
 * through the same real form. */
export const ownerTakesDownNews = async (
  world: TicketsWorld,
  name: string,
  typed: string,
): Promise<void> => {
  const id = world.things.require("record", name);
  const browser = await openAdminPage(world, `/admin/site/news/${id}/delete`);
  await fillInAndSend(
    browser,
    { confirm_identifier: typed },
    "Delete News Post",
  );
  world.ownerTold = browser.pageText;
};

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
