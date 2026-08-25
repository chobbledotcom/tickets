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

/** One story's watch, ready to be put in place: hand it the world the story
 * runs in and it stands the stand-in up, remembers it there, and hands it
 * back. Naming this is what makes a change to the shared shape fail where it
 * is written rather than at whichever story reads it next. */
export type PutsAWatchInPlace = (world: TicketsWorld) => WatchesOutgoing;

export const watchesOutgoing =
  (answer: AnswersTheOutsideWorld): PutsAWatchInPlace =>
  (world) => {
    const watching = installRecordingFetch(answer);
    world.cleanup.add(watching.restore);
    world.messagesOut = watching;
    return watching;
  };

/** Answer the email provider with this status for one story, and remember
 * every send. Curried on how the provider's day is going, so a story about a
 * delivery and a story about a failure are the same watch with different
 * answers. */
export const answersTheEmailProviderWith = (
  status: number,
): PutsAWatchInPlace =>
  watchesOutgoing((url) =>
    url.includes("api.resend.com") ? new Response(null, { status }) : null,
  );
