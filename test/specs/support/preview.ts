/**
 * The editor's preview of formatted text: the real preview endpoint's answer
 * for one piece of text, kept so the story can hold it to what it shows.
 */

import {
  keepWhatTheyWereTold,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
// jscpd:ignore-start
import { createTestEditorSession, postFormAs } from "#test-utils/session.ts";
// jscpd:ignore-end

/** Whose preview the story reads. */
export const PREVIEWER = "the editor";

/** The editor previews one piece of text and the answer is kept for the steps
 * that read it back. The story names the editor, so the preview is posted
 * from an editor's own session — the owner's session would let the story pass
 * as somebody it never named. */
export const previewsText = async (
  world: TicketsWorld,
  content: string,
): Promise<void> => {
  const { cookie } = await createTestEditorSession();
  const response = await postFormAs("/admin/markdown-preview", cookie, {
    content,
  });
  keepWhatTheyWereTold(world, PREVIEWER, await response.text());
};
