/**
 * What the site does with the outside world while one story runs.
 *
 * Every story that reads what was sent wants the same three things: a
 * stand-in that answers the outside world, every send remembered, and the real
 * thing put back when the scenario ends — otherwise one story's stand-in
 * reaches the next. Only the answers differ, so that is the only part passed.
 */

import type { TicketsWorld } from "#test/specs/support/world.ts";
import { installRecordingFetch } from "#test-utils/mocks.ts";

/** How a story answers one call to the outside world, or nothing to let it
 * through untouched. */
export type AnswersTheOutsideWorld = (
  url: string,
) => Response | Promise<Response> | null;

export type WatchesOutgoing = ReturnType<typeof installRecordingFetch>;

export const watchesOutgoing =
  (answer: AnswersTheOutsideWorld) =>
  (world: TicketsWorld): WatchesOutgoing => {
    const watching = installRecordingFetch(answer);
    world.cleanup.add(watching.restore);
    world.messagesOut = watching;
    return watching;
  };
