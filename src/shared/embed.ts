/**
 * Embed code generation - shared by single-listing and multi-booking views
 */

import { EMBED_JS_PATH } from "#shared/asset-paths.ts";

const DEFAULT_IFRAME_HEIGHT = "600px";

const parseEmbedUrl = (url: string): URL => {
  if (!URL.canParse(url)) throw new TypeError("Invalid embed URL");
  return new URL(url);
};

const extractListingSlugs = (url: URL): string[] => {
  const slugPart = url.pathname.match(/\/ticket\/([^/]+)/)?.[1] ?? "";
  return slugPart
    .split("+")
    .map((slug) => slug.trim())
    .filter((slug) => slug.length > 0);
};

const appendIframeParam = (url: URL): string => {
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
  const parsed = parseEmbedUrl(url);
  const origin = parsed.origin;
  const listings = extractListingSlugs(parsed).join("+");
  const script = `<script async src="${origin}${EMBED_JS_PATH}" data-listings="${listings}"></script>`;
  const iframe = `<iframe src="${appendIframeParam(
    parsed,
  )}" loading="lazy" style="border: none; width: 100%; height: ${DEFAULT_IFRAME_HEIGHT};">Loading..</iframe>`;

  return { iframe, script };
};
