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

/** Put a page-specific bundle beside admin.js, preserving its cache suffix. */
const bundleUrl = (path: string): string => {
  const adminUrl = [
    ...document.querySelectorAll<HTMLScriptElement>("script[src]"),
  ]
    .map((script) => new URL(script.src))
    .find((url) => url.pathname.endsWith("/admin.js"));
  if (!adminUrl) return path;
  const target = new URL(path.slice(path.lastIndexOf("/") + 1), adminUrl);
  target.search = adminUrl.search;
  return target.origin === document.location.origin
    ? `${target.pathname}${target.search}`
    : target.toString();
};

/** Inject `scriptPath` (and `stylesheetPath`, when given) into the page head
 * when the page contains an element matching `selector`. */
export const loadBundleWhen = (
  selector: string,
  scriptPath: string,
  stylesheetPath?: string,
): void => {
  if (!document.querySelector(selector)) return;
  if (stylesheetPath) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = bundleUrl(stylesheetPath);
    document.head.appendChild(link);
  }
  const script = document.createElement("script");
  script.src = bundleUrl(scriptPath);
  script.defer = true;
  document.head.appendChild(script);
};
