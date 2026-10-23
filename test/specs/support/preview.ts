/**
 * The editor's preview of formatted text: the real preview endpoint's answer
 * for one piece of text, kept so the story can hold it to what it shows.
 */

import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
// jscpd:ignore-start
import { adminFormPost } from "#test-utils/session.ts";
// jscpd:ignore-end

/** Whose preview the story reads. */
export const PREVIEWER = "the editor";

/** The editor previews one piece of text and the answer is kept for the
 * steps that read it back. */
export const previewsText = async (
  world: TicketsWorld,
  content: string,
): Promise<void> => {
  const { response } = await adminFormPost("/admin/markdown-preview", {
    content,
  });
  keepWhatTheyWereTold(world, PREVIEWER, await response.text());
};
