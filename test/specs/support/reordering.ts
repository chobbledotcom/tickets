/**
 * Moving one row up or down a list the site puts in an order.
 *
 * Every row on such a list renders the same arrow, so a story finds its own
 * row's arrow by the address that arrow's form posts to — pressing the first
 * one on the page would move somebody else's row. The form itself is then
 * submitted from the page in front of the person, so an arrow that is switched
 * off, or whose form the page stopped rendering, fails the story instead of
 * being reached around. A row the list offers no arrow for is one that can go
 * no further, which is how the site says "nowhere left to go" — so a story
 * asks whether the arrow is there, and pressing one that is not fails.
 */

import type { OpensAtOneRow } from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

export type Direction = "up" | "down";

/** Moving one named row around a list. */
export interface MovesNamedRows {
  /** Whether the list offers to move this row that way at all. */
  canMove(
    world: TicketsWorld,
    name: string,
    direction: Direction,
  ): Promise<boolean>;
  /** Press this row's own arrow. A row the list offers no arrow for is one
   * nobody could move, so this fails rather than quietly doing nothing. */
  move(world: TicketsWorld, name: string, direction: Direction): Promise<void>;
}

export const movingRowsOn = (
  listPath: string,
  openAt: OpensAtOneRow,
): MovesNamedRows => {
  /** The list in front of somebody, and where this row's arrow for going that
   * way posts — or nothing when the list offers them no such arrow. */
  const arrowFor = async (
    world: TicketsWorld,
    name: string,
    direction: Direction,
  ): Promise<{ browser: TestBrowser; posts: string | null }> => {
    const { browser, id } = await openAt(world, name);
    const posts = `${listPath}/${id}/move-${direction}`;
    return {
      browser,
      posts: browser.currentHtml.includes(posts) ? posts : null,
    };
  };
  return {
    canMove: async (world, name, direction) =>
      (await arrowFor(world, name, direction)).posts !== null,
    move: async (world, name, direction) => {
      const { browser, posts } = await arrowFor(world, name, direction);
      if (!posts) {
        throw new Error(
          `The list offers no way to move "${name}" ${direction}`,
        );
      }
      await browser.submitFormAt(posts);
    },
  };
};
