/**
 * Iframe embed code generation - shared by single-event and multi-booking views
 */

import type { EventFields } from "#lib/types.ts";
import { parseEventFields } from "#templates/fields.ts";

const TEXTAREA_FIELDS: readonly string[] = ["address", "special_instructions"];
const BASE_HEIGHT = 14;
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

/** Placeholder used in embed code templates so the client can swap in the real URL */
export const EMBED_URL_PLACEHOLDER = "EMBED_URL";

/** Build a complete iframe embed code snippet for a ticket URL */
export const buildEmbedCode = (url: string, fields: EventFields): string =>
  buildEmbedTemplate(fields).replace(EMBED_URL_PLACEHOLDER, url);

/** Build an embed code template with a placeholder URL (for client-side URL substitution) */
export const buildEmbedTemplate = (fields: EventFields): string => {
  const height = computeIframeHeight(fields);
  return `<iframe src="${EMBED_URL_PLACEHOLDER}?iframe=true" loading="lazy" style="border: none; width: 100%; height: ${height}">Loading..</iframe>`;
};
