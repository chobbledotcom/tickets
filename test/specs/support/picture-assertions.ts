/**
 * The one picture check every picture story makes about a rendered page: the
 * picture shows at its own address, and no raw `img#N` reference stays in the
 * text the story watches.
 */

import { assert, assertStringIncludes } from "@std/assert";

/** The shown text holds the picture at its own address, and the watched text
 * keeps no raw reference. When the story watches no separate text, the shown
 * text is the one watched. */
export const showsPicture = (
  shown: string,
  tag: string,
  watched: string = shown,
): void => {
  assertStringIncludes(shown, tag);
  assert(!watched.includes("img#"));
};
