/**
 * The one way a story says the site sells something plain.
 *
 * Several stories start from a thing that is simply on sale, and none of them
 * is about the thing itself. Keeping that one sentence here stops each story
 * growing its own wording — and its own slightly different fixture — for the
 * same setup.
 */

import { Given } from "@cucumber/cucumber";
import { putsPlainThingOnSale } from "#test/specs/support/listings.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

Given(
  "the site sells a {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    await putsPlainThingOnSale(this, name);
  },
);
