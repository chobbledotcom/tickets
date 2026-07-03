/// <reference lib="dom" />
/**
 * Entry point for the rich markdown editor bundle (`/markdown-editor.js`).
 *
 * ProseMirror is by far the heaviest client dependency, and most admin pages
 * have no markdown field, so the editor ships as its own bundle instead of
 * inside `admin.js`. The admin bundle's loader (`admin/markdown-editor-loader.ts`)
 * injects this script only when the page actually contains a markdown
 * textarea; by then the DOM is ready and the preview module has already laid
 * out the footer strips the editor's toggle buttons join.
 */

import { initMarkdownEditor } from "./admin/markdown-editor.ts";

initMarkdownEditor();
