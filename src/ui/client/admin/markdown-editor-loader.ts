/// <reference lib="dom" />
/**
 * Markdown editor loader: injects the separate `/markdown-editor.js` bundle
 * when (and only when) the page has a markdown-authored textarea. ProseMirror
 * multiplies the admin bundle's size many times over, so pages without a
 * markdown field must not pay for it — see `../markdown-editor.ts`.
 *
 * Both bundles are served with year-long immutable cache headers, and edge
 * builds cache-bust them with a `?ts=` query. That query only exists in the
 * server-rendered markup (client bundles are built before the edge build
 * stamps it), so the loader reuses the suffix from the admin bundle's own
 * script tag — whatever busted the admin bundle busts the editor too.
 */

const ADMIN_BUNDLE_PATH = "/admin.js";
const EDITOR_BUNDLE_PATH = "/markdown-editor.js";

export const initMarkdownEditorLoader = (): void => {
  if (!document.querySelector("textarea[data-markdown-preview]")) return;
  const adminSrc = document
    .querySelector(`script[src^="${ADMIN_BUNDLE_PATH}"]`)
    ?.getAttribute("src");
  const script = document.createElement("script");
  script.src =
    EDITOR_BUNDLE_PATH + (adminSrc?.slice(ADMIN_BUNDLE_PATH.length) ?? "");
  script.defer = true;
  document.head.appendChild(script);
};
