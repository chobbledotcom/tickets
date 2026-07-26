/**
 * Where the built browser assets land.
 *
 * Kept apart from the build itself so the test harness can look at the output
 * list — and decide the assets are still up to date — without loading esbuild
 * and sass.
 */

import { resolve } from "@std/path";

const STATIC_DIR = "./src/ui/static";

/**
 * Output files produced by the static asset build, keyed by bundle. These are
 * generated build artifacts (gitignored).
 */
export const STATIC_ASSET_OUTFILES = {
  admin: `${STATIC_DIR}/admin.js`,
  contact: `${STATIC_DIR}/contact.js`,
  css: `${STATIC_DIR}/style.css`,
  embed: `${STATIC_DIR}/embed.js`,
  iframeResizerChild: `${STATIC_DIR}/iframe-resizer-child.js`,
  iframeResizerParent: `${STATIC_DIR}/iframe-resizer-parent.js`,
  logisticsMap: `${STATIC_DIR}/logistics-map.js`,
  markdownEditor: `${STATIC_DIR}/markdown-editor.js`,
  order: `${STATIC_DIR}/order.js`,
  scanner: `${STATIC_DIR}/scanner.js`,
} as const;

/** Source SCSS stylesheet compiled to {@link STATIC_ASSET_OUTFILES.css}. */
export const CSS_ENTRY = `${STATIC_DIR}/style.scss`;

/** Every built asset, as an absolute path, in a stable order. */
export const staticAssetOutputFiles = (): string[] =>
  Object.values(STATIC_ASSET_OUTFILES)
    .map((outfile) => resolve(Deno.cwd(), outfile))
    .sort();
