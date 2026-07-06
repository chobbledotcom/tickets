/// <reference lib="dom" />
/**
 * Page-specific extra bundles: inject a separate script (and optional
 * stylesheet) only when the page contains the element it enhances, so pages
 * without that element never pay for the extra download. Used for the
 * markdown editor (ProseMirror) and the logistics map (Leaflet).
 *
 * Both bundles are served with year-long immutable cache headers, and edge
 * builds cache-bust them with a `?ts=` query. That query only exists in the
 * server-rendered markup (client bundles are built before the edge build
 * stamps it), so the loader reuses the suffix from the admin bundle's own
 * script tag — whatever busted the admin bundle busts the extras too.
 */

const ADMIN_BUNDLE_PATH = "/admin.js";

/** The cache-busting suffix stamped on the admin bundle ("" in dev). */
const cacheBustSuffix = (): string =>
  document
    .querySelector(`script[src^="${ADMIN_BUNDLE_PATH}"]`)
    ?.getAttribute("src")
    ?.slice(ADMIN_BUNDLE_PATH.length) ?? "";

/** Inject `scriptPath` (and `stylesheetPath`, when given) into the page head
 * when the page contains an element matching `selector`. */
export const loadBundleWhen = (
  selector: string,
  scriptPath: string,
  stylesheetPath?: string,
): void => {
  if (!document.querySelector(selector)) return;
  const suffix = cacheBustSuffix();
  if (stylesheetPath) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = stylesheetPath + suffix;
    document.head.appendChild(link);
  }
  const script = document.createElement("script");
  script.src = scriptPath + suffix;
  script.defer = true;
  document.head.appendChild(script);
};
