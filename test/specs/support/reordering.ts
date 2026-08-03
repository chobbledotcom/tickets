/**
 * Moving one row up or down a list the site puts in an order.
 *
 * Every row on such a list renders the same arrow, so a story finds its own
 * row's arrow by where that arrow posts — pressing the first one on the page
 * would move somebody else's row. A row the list offers no arrow for is one
 * that can go no further, which is how the site says "nowhere left to go"
 * rather than accepting a request that quietly does nothing.
 */

import type { TicketsWorld } from "#test/specs/support/world.ts";
import { adminFormPost } from "#test-utils/session.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

export type Direction = "up" | "down";

/** A list open at one row: the page somebody is looking at, and the number the
 * site files that row under. */
export type OpensAtOneRow = (
  world: TicketsWorld,
  name: string,
) => Promise<{ browser: TestBrowser; id: number }>;

/** Moving one named row around a list. */
export interface MovesNamedRows {
  /** Whether the list offers to move this row that way at all. */
  canMove(
    world: TicketsWorld,
    name: string,
    direction: Direction,
  ): Promise<boolean>;
  /** Press this row's own arrow. A row with no arrow that way is left alone. */
  move(world: TicketsWorld, name: string, direction: Direction): Promise<void>;
}

export const movingRowsOn = (
  listPath: string,
  openAt: OpensAtOneRow,
): MovesNamedRows => {
  /** This row's own arrow for going that way, read off the list somebody is
   * looking at, or nothing when the list offers none. */
  const arrowFor = async (
    world: TicketsWorld,
    name: string,
    direction: Direction,
  ): Promise<string | null> => {
    const { browser, id } = await openAt(world, name);
    const arrow = `${listPath}/${id}/move-${direction}`;
    return browser.currentHtml.includes(arrow) ? arrow : null;
  };
  return {
    canMove: async (world, name, direction) =>
      (await arrowFor(world, name, direction)) !== null,
    move: async (world, name, direction) => {
      const arrow = await arrowFor(world, name, direction);
      if (arrow) await adminFormPost(arrow, {});
    },
  };
};
