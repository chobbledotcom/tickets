/**
 * The addresses the site sells things from, worked out in one place.
 *
 * A story names the things it wants; where the site sells them is the site's
 * business, so no story builds one of these addresses itself. One thing has
 * its own page, and several bought together share one page named after all of
 * them.
 */

import { listingNamed } from "#test/specs/support/listings.ts";
import type { OrderLine } from "#test/specs/support/public-booking.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

/** The page several things are bought from together. */
export const combinedPath = (lines: OrderLine[]): string =>
  `/ticket/${lines.map(({ listing }) => listing.slug).join("+")}`;

/** An order the site can be handed: the page it is bought from, and the lines
 * that make it up. The two are worked out together so they can never describe
 * different things. */
export type OrderOnAPage = [path: string, lines: OrderLine[]];

const orderOf = (lines: OrderLine[]): OrderOnAPage => [
  combinedPath(lines),
  lines,
];

/** The order for one named thing on its own page — however many places, and
 * whatever else the story asks for on that line. */
/** Everything a story says about one line of an order except which thing it
 * is for. The page it is ordered from already names that. */
export type LineWithoutItsThing = Omit<OrderLine, "listing">;

export const ownPageOrder = (
  world: TicketsWorld,
  name: string,
  line: LineWithoutItsThing = {},
): OrderOnAPage => orderOf([{ listing: listingNamed(world, name), ...line }]);

/** The order for some named things bought together, in the order the story
 * named them. */
export const togetherPageOrder = (
  world: TicketsWorld,
  wanted: { name: string; places: number }[],
): OrderOnAPage =>
  orderOf(
    wanted.map(({ name, places }) => ({
      listing: listingNamed(world, name),
      places,
    })),
  );
