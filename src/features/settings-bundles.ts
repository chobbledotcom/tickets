/**
 * Per-request settings pre-load (see settings-plan.md §4).
 *
 * The pre-routing pipeline reads settings before the lazy router resolves a
 * handler. The per-prefix bundles live on the prefix declaration
 * (PREFIX_ROUTES in app/prefixes.ts); this module unions a prefix's bundle
 * with INFRA_SETTINGS. The whole set is fetched in one `WHERE key IN (...)`
 * query.
 */

import { CONFIG_KEYS } from "#db/settings.ts";
import { ALL_SNAPSHOT_SETTINGS } from "#routes/app/prefix-settings.ts";
import {
  getPrefix,
  PREFIX_ROUTES,
  type PrefixSpec,
} from "#routes/app/prefixes.ts";

/**
 * Keys every request needs regardless of route. Each entry exists because an
 * unconditional read needs it. Readers include domain resolution, routing
 * gates, the bare `Layout`, the CSP rebuild, session auth, PII decryption,
 * and the listing defaults at the cache layer. The listing defaults load on
 * any route that touches a listing.
 */
const INFRA_SETTINGS: readonly string[] = [
  CONFIG_KEYS.LISTING_DEFAULTS,
  CONFIG_KEYS.ENABLED_FEATURES,
  // The CSP rebuild reads the saved flag that says the custom CSS loads
  // Bunny's fonts. The flag is scanned when the CSS is saved (see
  // bunny-fonts.ts).
  CONFIG_KEYS.CUSTOM_CSS_BUNNY_FONTS,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.SETUP_COMPLETE,
  CONFIG_KEYS.SHOW_PUBLIC_API,
  CONFIG_KEYS.THEME,
  CONFIG_KEYS.UNDERLINE_LINKS,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  // The Layout renders the site footer on every page but admin's, so the key
  // rides with the other Layout-read settings.
  CONFIG_KEYS.SITE_FOOTER,
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.AUTO_PURGE_ORPHANS,
  CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
  CONFIG_KEYS.PUBLIC_KEY,
  CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
];

/** Settings to pre-load for a path: infra ∪ the prefix's bundle. */
export const settingsForPath = (path: string): readonly string[] => {
  const prefix = getPrefix(path);
  const table: Record<string, PrefixSpec> = PREFIX_ROUTES;
  const spec = Object.hasOwn(table, prefix) ? table[prefix] : undefined;
  return [...INFRA_SETTINGS, ...(spec ? spec.settings : ALL_SNAPSHOT_SETTINGS)];
};
