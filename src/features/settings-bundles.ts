/**
 * Per-request settings pre-load bundles (see settings-plan.md §4).
 *
 * The pre-routing pipeline reads settings before the lazy router resolves a
 * handler, so the load is keyed off the path *prefix* (pure, import-free).
 * `settingsForPath` always unions the prefix bundle with INFRA_SETTINGS, so
 * the per-prefix bundles below list only the *extra* keys a route reads
 * beyond infra. The whole set is fetched in one `WHERE key IN (...)` query.
 */

import { CONFIG_KEYS, EMAIL_BODY_KEYS, SNAPSHOT_KEYS } from "#db/settings.ts";

/** Extract first path segment for O(1) prefix dispatch */
export const getPrefix = (path: string): string => {
  const i = path.indexOf("/", 1);
  return i === -1 ? path.slice(1) : path.slice(1, i);
};

/**
 * Keys every request needs regardless of route:
 * - domain resolution (`loadEffectiveDomain`) reads custom_domain + bunny_subdomain
 * - routing gates on setup_complete / enabled_features / show_public_api
 * - the bare `Layout` (rendered by the universal `notFoundResponse` fallback
 *   and every HTML error page) reads theme + underline_links + header_image_url
 * - `applySecurityHeaders` rebuilds the CSP on every routed response, reading
 *   the payment provider (and square_sandbox when the provider is Square)
 * - session auth + PII decryption read the key material
 * - listing reads resolve listing defaults at the cache layer
 *   (`resolveListingDefaults`), which can run on any route that loads a listing;
 *   that resolution also reads enabled_features to gate the public site and
 *   the logistics default
 */
const INFRA_SETTINGS: readonly string[] = [
  CONFIG_KEYS.LISTING_DEFAULTS,
  CONFIG_KEYS.ENABLED_FEATURES,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.SETUP_COMPLETE,
  CONFIG_KEYS.SHOW_PUBLIC_API,
  CONFIG_KEYS.THEME,
  CONFIG_KEYS.UNDERLINE_LINKS,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.AUTO_PURGE_ORPHANS,
  CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
  CONFIG_KEYS.PUBLIC_KEY,
  CONFIG_KEYS.WRAPPED_PRIVATE_KEY,
];

/**
 * Extra keys the full public-page nav reads (theme + header are in infra).
 * Rendered by pages built on `publicPage`/`PublicNav` (home, listings, terms,
 * contact, order, ticket forms). Pages on the bare `Layout` don't need these.
 */
const PUBLIC_NAV_SETTINGS: readonly string[] = [
  CONFIG_KEYS.WEBSITE_TITLE,
  CONFIG_KEYS.CONTACT_PAGE_TEXT,
  CONFIG_KEYS.CONTACT_FORM_ENABLED,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.ORDER_ENABLED,
  CONFIG_KEYS.TERMS_AND_CONDITIONS,
];

/** Keys needed to resolve providers for new checkouts and existing payments. */
const PAYMENT_SETTINGS: readonly string[] = [
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.LAST_ACTIVE_PAYMENT_PROVIDER,
  CONFIG_KEYS.COUNTRY,
  CONFIG_KEYS.BOOKING_FEE,
  CONFIG_KEYS.STRIPE_SECRET_KEY,
  CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
  CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
  CONFIG_KEYS.SQUARE_ACCESS_TOKEN,
  CONFIG_KEYS.SQUARE_LOCATION_ID,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.SQUARE_WEBHOOK_SIGNATURE_KEY,
  CONFIG_KEYS.SUMUP_API_KEY,
  CONFIG_KEYS.SUMUP_MERCHANT_CODE,
];

/** Keys the registration/confirmation email pipeline reads. */
const EMAIL_SETTINGS: readonly string[] = [
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.EMAIL_PROVIDER,
  ...EMAIL_BODY_KEYS,
];

/** Apple Wallet pass generation reads all five cert/identifier keys. */
const APPLE_WALLET_SETTINGS: readonly string[] = [
  CONFIG_KEYS.APPLE_WALLET_PASS_TYPE_ID,
  CONFIG_KEYS.APPLE_WALLET_TEAM_ID,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_CERT,
  CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
  CONFIG_KEYS.APPLE_WALLET_WWDR_CERT,
];

/** Google Wallet pass generation reads all three issuer/service-account keys. */
const GOOGLE_WALLET_SETTINGS: readonly string[] = [
  CONFIG_KEYS.GOOGLE_WALLET_ISSUER_ID,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
  CONFIG_KEYS.GOOGLE_WALLET_SERVICE_ACCOUNT_KEY,
];

/**
 * Extra keys read when an *owner* session authenticates: the settings-nag
 * banner (`getSettingsNagItemsForOwner`) checks the payment provider, business
 * email, superuser choice, and domain config (custom_domain + bunny_subdomain
 * are already infra).
 */
const OWNER_AUTH_SETTINGS: readonly string[] = [
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.BUSINESS_EMAIL,
  CONFIG_KEYS.SUPERUSER_CHOICE,
];

/** The whole booking flow (form + checkout + confirmation emails). */
const BOOKING_FLOW_SETTINGS: readonly string[] = [
  ...PUBLIC_NAV_SETTINGS,
  ...PAYMENT_SETTINGS,
  ...EMAIL_SETTINGS,
];

/**
 * The full snapshot, for routes that may touch any setting — the admin HTML
 * pages and the public booking API (`POST /api/.../book` fans out into the
 * entire payment + email + country surface). `admin` additionally reads
 * `db_schema_hash` on the debug page (written by migrations, not a snapshot
 * field). INFRA is added by `settingsForPath`.
 */
const ALL_SNAPSHOT_SETTINGS: readonly string[] = SNAPSHOT_KEYS;
const ADMIN_SETTINGS: readonly string[] = [...SNAPSHOT_KEYS, "db_schema_hash"];

/**
 * Per-prefix settings bundle (keys *beyond* INFRA_SETTINGS). Every prefix in
 * `prefixHandlers` must be listed; an unlisted prefix falls back to the full
 * snapshot. Empty arrays mean "infra is enough" (binary/JSON routes and pure
 * redirects whose only HTML is the themed error fallback).
 */
const PREFIX_SETTINGS: Record<string, readonly string[]> = {
  // --- Public HTML pages (full nav) ---
  "": [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.HOMEPAGE_TEXT, CONFIG_KEYS.COUNTRY],
  // --- Address lookup proxy (JSON only): provider choice + its API key.
  // Session resolution (staff skip the rate limit) can hit the owner
  // settings-nag reads, so the owner-auth keys ride along. ---
  "address-lookup": [
    CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
    CONFIG_KEYS.ADDRESS_LOOKUP_API_KEY,
    ...OWNER_AUTH_SETTINGS,
  ],
  // --- Everything (may touch any setting) ---
  admin: ADMIN_SETTINGS,
  api: ALL_SNAPSHOT_SETTINGS,
  attachment: [],
  // Booking running total: reprices the cart with the same code path as
  // /ticket, so it needs the same booking-flow settings (not the full snapshot).
  calculate: [
    ...BOOKING_FLOW_SETTINGS,
    CONFIG_KEYS.EMBED_HOSTS,
    CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
  ],
  caldav: ALL_SNAPSHOT_SETTINGS,
  // --- Check-in (owner-authenticated admin view) ---
  checkin: [
    CONFIG_KEYS.COUNTRY,
    CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
    ...OWNER_AUTH_SETTINGS,
  ],
  // Contact form submission sends an email to the business address.
  contact: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY, ...EMAIL_SETTINGS],
  // The custom stylesheet route reads only the custom_css setting.
  "custom.css": [CONFIG_KEYS.CUSTOM_CSS],
  demo: [],
  events: [],
  // --- Feeds (ICS/RSS): website title + country (timezone) ---
  feeds: [CONFIG_KEYS.WEBSITE_TITLE, CONFIG_KEYS.COUNTRY],
  gwallet: [...GOOGLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  // --- Infra-only routes (binary/JSON responses or pure redirects) ---
  image: [],
  // Inter-instance machine endpoint: reads built_sites + an env key only.
  instance: [],
  join: [],
  listings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  // --- Public news list + post pages (full public nav; country because the
  // published-date display reads the timezone) ---
  news: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  order: [
    ...PUBLIC_NAV_SETTINGS,
    CONFIG_KEYS.ORDER_INTRO_TEXT,
    CONFIG_KEYS.COUNTRY,
  ],
  // External order library module: enable flag + embed allow-list (CORS) +
  // country (currency for the embedded prices). No public nav, no secrets.
  "order.js": [
    CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
    CONFIG_KEYS.EMBED_HOSTS,
    CONFIG_KEYS.COUNTRY,
  ],
  // --- User-created content pages (full public nav; country because the
  // nav's group-liveness check reaches the timezone-aware calendar reads) ---
  page: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  // --- Checkout / payment (bare layout, no public nav) ---
  pay: PAYMENT_SETTINGS,
  payment: [...PAYMENT_SETTINGS, ...EMAIL_SETTINGS],
  "read-only": [],
  // Renewal renders the same booking form, whose contact-field builder checks
  // the address-lookup provider.
  renew: [...BOOKING_FLOW_SETTINGS, CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER],
  setup: [],
  // --- Inbound SMS webhook (JSON only) ---
  sms: [
    CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
    CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
  ],
  // --- Ticket view + wallet passes ---
  t: [CONFIG_KEYS.COUNTRY, ...APPLE_WALLET_SETTINGS, ...GOOGLE_WALLET_SETTINGS],
  terms: PUBLIC_NAV_SETTINGS,
  // --- Booking flows (form + checkout + emails) ---
  // Ticket pages are embeddable, so applySecurityHeaders reads embed_hosts.
  // The form render checks the address-lookup provider to decide whether the
  // address field gets a postcode search box.
  ticket: [
    ...BOOKING_FLOW_SETTINGS,
    CONFIG_KEYS.EMBED_HOSTS,
    CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
  ],
  // --- Unsubscribe page (bare layout + page title) ---
  unsubscribe: [CONFIG_KEYS.WEBSITE_TITLE],
  v1: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  wallet: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
};

/** Settings to pre-load for a path: infra ∪ the prefix's bundle. */
export const settingsForPath = (path: string): readonly string[] => {
  const prefix = getPrefix(path);
  const bundle = Object.hasOwn(PREFIX_SETTINGS, prefix)
    ? PREFIX_SETTINGS[prefix]
    : undefined;
  return [...INFRA_SETTINGS, ...(bundle ?? ALL_SNAPSHOT_SETTINGS)];
};
