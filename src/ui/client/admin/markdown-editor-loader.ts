/// <reference lib="dom" />
/**
 * Markdown editor loader: injects the separate `/markdown-editor.js` bundle
 * when (and only when) the page has a markdown-authored textarea. ProseMirror
 * multiplies the admin bundle's size many times over, so pages without a
 * markdown field must not pay for it — see `../markdown-editor.ts`.
 */

import { loadBundleWhen } from "./bundle-loader.ts";

export const initMarkdownEditorLoader = (): void =>
  loadBundleWhen("textarea[data-markdown-preview]", "/markdown-editor.js");
