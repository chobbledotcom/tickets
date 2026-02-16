/**
 * Embed code generation - shared by single-event and multi-booking views
 */

import { EMBED_JS_PATH } from "#src/config/asset-paths.ts";

const DEFAULT_IFRAME_HEIGHT = "600px";

const extractEventSlugs = (url: string): string[] => {
  const slugPart = new URL(url).pathname.match(/\/ticket\/([^/]+)/)?.[1] ?? "";
  return slugPart
    .split("+")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
};

const appendIframeParam = (url: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set("iframe", "true");
  return parsed.toString();
};

export type EmbedSnippets = {
  script: string;
  iframe: string;
};

/** Build embed snippets (script and iframe variants) for a ticket URL */
export const buildEmbedSnippets = (url: string): EmbedSnippets => {
  const origin = new URL(url).origin;
  const events = extractEventSlugs(url).join("+");
  const script =
    `<script async src="${origin}${EMBED_JS_PATH}" data-events="${events}"></script>`;
  const iframe =
    `<iframe src="${appendIframeParam(url)}" loading="lazy" style="border: none; width: 100%; height: ${DEFAULT_IFRAME_HEIGHT};">Loading..</iframe>`;

  return { script, iframe };
};
