/**
 * Iframe embed code generation - shared by single-event and multi-booking views
 */

import type { EventFields } from "#lib/types.ts";
import { parseEventFields } from "#lib/event-fields.ts";

const TEXTAREA_FIELDS: readonly string[] = ["address", "special_instructions"];
const BASE_HEIGHT = 11;
const INPUT_HEIGHT = 4;
const TEXTAREA_HEIGHT = 6;

/** Compute iframe height (in rem) from an event fields setting */
export const computeIframeHeight = (fields: EventFields): string => {
  const parsed = parseEventFields(fields);
  let inputs = 0;
  let textareas = 0;
  for (const f of parsed) {
    if (TEXTAREA_FIELDS.includes(f)) textareas++;
    else inputs++;
  }
  return `${BASE_HEIGHT + inputs * INPUT_HEIGHT + textareas * TEXTAREA_HEIGHT}rem`;
};

/** Build a complete iframe embed code snippet for a ticket URL */
export const buildEmbedCode = (url: string, fields: EventFields): string => {
  const height = computeIframeHeight(fields);
  const origin = new URL(url).origin;
  return (
    `<script src="${origin}/iframe-resizer-parent.js"></script>` +
    `<iframe src="${url}?iframe=true" loading="lazy" style="border: none; width: 100%; height: ${height}">Loading..</iframe>` +
    `<script>iframeResize({license:'GPLv3'},document.currentScript.previousElementSibling)</script>`
  );
};
