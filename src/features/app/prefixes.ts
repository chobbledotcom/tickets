/**
 * The one declaration behind path-prefix routing (issue #2268). Every path
 * prefix states the module that serves it, the message groups its handlers
 * render, an optional gate, and the settings bundle its handlers read.
 * Consumers fold this one table: `prefixHandlers` dispatches, and
 * `settingsForPath` pre-loads settings. The admin surface folds the same way
 * one level down (src/shared/admin-surface/areas.ts).
 *
 * No route handler module is statically imported here, so the pre-routing
 * settings pipeline reads this file without loading the app
 * (test/scripts/cold-start-imports.test.ts).
 */

import { CONFIG_KEYS } from "#db/settings.ts";
import {
  ADMIN_SHELL_MESSAGE_GROUPS,
  JOIN_MESSAGE_GROUPS,
  publicMessageGroups,
} from "#locales/groups.ts";
import type { MessageGroup } from "#locales/manifest.ts";
import {
  apiPrefixHandler,
  contactPrefixHandler,
  customCssPrefixHandler,
  disabledPublicSiteGet,
  feedLoader,
  handlerLoader,
  inlineLoader,
  legacyEventsRedirectHandler,
  loadPublicPages,
  orderJsPrefixHandler,
  type PrefixLoaderThunk,
  readOnlyInfoHandler,
  requirePublicSiteGet,
  routesObjectLoader,
  routeTableLoader,
  ticketLoader,
} from "./prefix-loaders.ts";
import {
  ADMIN_SETTINGS,
  ALL_SNAPSHOT_SETTINGS,
  APPLE_WALLET_SETTINGS,
  BOOKING_FLOW_SETTINGS,
  EMAIL_SETTINGS,
  EMBEDDABLE_BOOKING_FLOW_SETTINGS,
  GOOGLE_WALLET_SETTINGS,
  OWNER_AUTH_SETTINGS,
  PAYMENT_SETTINGS,
  PUBLIC_NAV_SETTINGS,
} from "./prefix-settings.ts";

/** One path prefix's full set of routing facts. */
export type PrefixSpec = {
  /** A gate that can answer before message groups load. Absent = no gate. */
  gate?: (path: string, method: string) => Response | null;
  /** The message-group bundle the handlers render. Empty = no route copy. */
  groups: readonly MessageGroup[];
  /**
   * How the prefix loads its handler. Absent only for `setup`, which the
   * setup router serves before main dispatch (see request.ts).
   */
  loader?: PrefixLoaderThunk;
  /** Setting keys beyond infra that the handlers read. Empty = infra only. */
  settings: readonly string[];
};

/**
 * The declaration. An entry here is the only place a prefix's loader, groups,
 * gate, and settings bundle are written. The paired fold test
 * (test/features/app/prefix-fold.test.ts) freezes these facts from the four
 * pre-fold tables and checks every entry against them.
 */
export const PREFIX_ROUTES = {
  // --- Public HTML pages (full nav) ---
  "": {
    gate: requirePublicSiteGet("/"),
    groups: publicMessageGroups("public-site"),
    loader: routeTableLoader(loadPublicPages, { "GET /": "handleHome" }),
    settings: [
      ...PUBLIC_NAV_SETTINGS,
      CONFIG_KEYS.HOMEPAGE_TEXT,
      CONFIG_KEYS.COUNTRY,
    ],
  },
  // --- Address lookup proxy (JSON only): provider choice + its API key.
  // Session resolution (staff skip the rate limit) can hit the owner
  // settings-nag reads, so the owner-auth keys ride along. ---
  "address-lookup": {
    groups: ["address-lookup"],
    loader: routeTableLoader(() => import("#routes/public/address-lookup.ts"), {
      "GET /address-lookup": "handleAddressLookupGet",
    }),
    settings: [
      CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER,
      CONFIG_KEYS.ADDRESS_LOOKUP_API_KEY,
      ...OWNER_AUTH_SETTINGS,
    ],
  },
  // --- Everything (can touch any setting) ---
  admin: {
    groups: [],
    loader: handlerLoader(() => import("#routes/admin/index.ts"), "routeAdmin"),
    settings: ADMIN_SETTINGS,
  },
  api: {
    groups: [],
    loader: inlineLoader(apiPrefixHandler),
    settings: ALL_SNAPSHOT_SETTINGS,
  },
  attachment: {
    groups: [],
    loader: routesObjectLoader(
      () => import("#routes/attachments.ts"),
      "attachmentRoutes",
    ),
    settings: [],
  },
  // Booking running total: reprices the cart with the same code path as
  // /ticket, so it needs the same booking-flow settings (not the full
  // snapshot).
  calculate: {
    groups: publicMessageGroups("payment", "tickets", "validation"),
    loader: ticketLoader,
    settings: EMBEDDABLE_BOOKING_FLOW_SETTINGS,
  },
  caldav: {
    groups: [],
    loader: feedLoader,
    settings: ALL_SNAPSHOT_SETTINGS,
  },
  // --- Check-in (owner-authenticated admin view) ---
  checkin: {
    groups: [
      ...ADMIN_SHELL_MESSAGE_GROUPS,
      "attendees",
      "check-in",
      "listing-qr",
      "validation",
    ],
    loader: handlerLoader(() => import("#routes/checkin.ts"), "routeCheckin"),
    settings: [
      CONFIG_KEYS.COUNTRY,
      CONFIG_KEYS.ATTENDEE_COLUMN_ORDER,
      ...OWNER_AUTH_SETTINGS,
    ],
  },
  // Contact form submission sends an email to the business address.
  contact: {
    gate: requirePublicSiteGet("/contact"),
    groups: publicMessageGroups("contact", "public-site", "validation"),
    loader: inlineLoader(contactPrefixHandler),
    settings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY, ...EMAIL_SETTINGS],
  },
  // The custom stylesheet route reads only the `custom_css` setting. The CSP
  // rebuild reads the derived flag, which is infra.
  "custom.css": {
    groups: [],
    loader: inlineLoader(customCssPrefixHandler),
    settings: [CONFIG_KEYS.CUSTOM_CSS],
  },
  demo: {
    groups: [...ADMIN_SHELL_MESSAGE_GROUPS, "login", "settings", "validation"],
    loader: handlerLoader(
      () => import("#routes/admin/database-reset.ts"),
      "routeDatabaseReset",
    ),
    settings: [],
  },
  events: {
    groups: [],
    loader: inlineLoader(legacyEventsRedirectHandler),
    settings: [],
  },
  // --- Feeds (ICS/RSS): website title + country (timezone) ---
  feeds: {
    groups: [],
    loader: feedLoader,
    settings: [CONFIG_KEYS.WEBSITE_TITLE, CONFIG_KEYS.COUNTRY],
  },
  gwallet: {
    groups: publicMessageGroups("tickets"),
    loader: handlerLoader(
      () => import("#routes/wallet/google.ts"),
      "routeGoogleWallet",
    ),
    settings: [...GOOGLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  // --- Infra-only routes (binary/JSON responses or pure redirects) ---
  image: {
    groups: [],
    loader: handlerLoader(() => import("#routes/images.ts"), "routeImage"),
    settings: [],
  },
  // Inter-instance machine endpoint: reads built_sites + an env key only.
  instance: {
    groups: [],
    loader: routesObjectLoader(
      () => import("#routes/instance.ts"),
      "instanceRoutes",
    ),
    settings: [],
  },
  join: {
    groups: JOIN_MESSAGE_GROUPS,
    loader: handlerLoader(() => import("#routes/join.ts"), "routeJoin"),
    settings: [],
  },
  listings: {
    gate: requirePublicSiteGet("/listings"),
    groups: publicMessageGroups(
      "attributes",
      "availability",
      "public-site",
      "tickets",
    ),
    loader: routeTableLoader(loadPublicPages, {
      "GET /listings": "handlePublicListings",
    }),
    settings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  // --- Public news list and post pages: full public nav, plus country
  // because the published-date display reads the timezone ---
  news: {
    gate: disabledPublicSiteGet,
    groups: publicMessageGroups("news", "public-site"),
    loader: handlerLoader(() => import("#routes/public/news.ts"), "routeNews"),
    settings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  order: {
    groups: publicMessageGroups(
      "availability",
      "capacity",
      "date-picker",
      "modifiers",
      "order",
      "public-site",
      "tickets",
      "validation",
    ),
    loader: handlerLoader(
      () => import("#routes/public/order.ts"),
      "routeOrder",
    ),
    settings: [
      ...PUBLIC_NAV_SETTINGS,
      CONFIG_KEYS.ORDER_INTRO_TEXT,
      CONFIG_KEYS.COUNTRY,
    ],
  },
  // External order library module: enable flag + embed allow-list (CORS) +
  // country (currency for the embedded prices). No public nav, no secrets.
  "order.js": {
    groups: [],
    loader: inlineLoader(orderJsPrefixHandler),
    settings: [
      CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
      CONFIG_KEYS.EMBED_HOSTS,
      CONFIG_KEYS.COUNTRY,
    ],
  },
  // --- User-created content pages: full public nav, plus country because
  // the nav group-liveness check reaches the timezone-aware calendar reads
  page: {
    gate: disabledPublicSiteGet,
    groups: publicMessageGroups("public-site", "site-pages"),
    loader: handlerLoader(
      () => import("#routes/public/site-page.ts"),
      "routeSitePage",
    ),
    settings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  // --- Checkout / payment (bare layout, no public nav) ---
  pay: {
    groups: publicMessageGroups("ledger", "payment", "tickets", "validation"),
    loader: handlerLoader(
      () => import("#routes/public/balance.ts"),
      "routeBalance",
    ),
    settings: PAYMENT_SETTINGS,
  },
  payment: {
    groups: ["payment", "validation"],
    loader: handlerLoader(
      () => import("#routes/api/webhooks.ts"),
      "routePayment",
    ),
    settings: [...PAYMENT_SETTINGS, ...EMAIL_SETTINGS],
  },
  "read-only": {
    groups: [],
    loader: inlineLoader(readOnlyInfoHandler),
    settings: [],
  },
  // Renewal renders the same booking form, whose contact-field builder checks
  // the address-lookup provider.
  renew: {
    groups: publicMessageGroups(
      "address-lookup",
      "payment",
      "public-site",
      "renewal",
      "tickets",
      "validation",
    ),
    loader: routeTableLoader(() => import("#routes/public/renewal.ts"), {
      "GET /renew": "handleRenewalGet",
      "POST /renew": "handleRenewalPost",
    }),
    settings: [...BOOKING_FLOW_SETTINGS, CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER],
  },
  // The setup router serves this prefix before main dispatch, so it declares
  // only its settings bundle.
  setup: {
    groups: [],
    settings: [],
  },
  // --- Inbound SMS webhook (JSON only) ---
  sms: {
    groups: [],
    loader: handlerLoader(
      () => import("#routes/api/sms-webhook.ts"),
      "routeSmsWebhook",
    ),
    settings: [
      CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
      CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
    ],
  },
  // --- Ticket view + wallet passes ---
  t: {
    groups: publicMessageGroups("listing-qr", "payment", "tickets"),
    loader: handlerLoader(
      () => import("#routes/tickets/index.ts"),
      "routeTicketView",
    ),
    settings: [
      CONFIG_KEYS.COUNTRY,
      ...APPLE_WALLET_SETTINGS,
      ...GOOGLE_WALLET_SETTINGS,
    ],
  },
  terms: {
    gate: requirePublicSiteGet("/terms"),
    groups: publicMessageGroups("public-site"),
    loader: routeTableLoader(loadPublicPages, {
      "GET /terms": "handlePublicTerms",
    }),
    settings: PUBLIC_NAV_SETTINGS,
  },
  // --- Booking flows (form + checkout + emails). Ticket pages are
  // embeddable, so applySecurityHeaders reads embed_hosts. The form render
  // checks the address-lookup provider to decide whether the address field
  // gets a postcode search box. ---
  ticket: {
    groups: publicMessageGroups(
      "address-lookup",
      "availability",
      "date-picker",
      "modifiers",
      "order",
      "payment",
      "public-site",
      "questions",
      "tickets",
      "validation",
    ),
    loader: ticketLoader,
    settings: EMBEDDABLE_BOOKING_FLOW_SETTINGS,
  },
  // --- Unsubscribe page (bare layout + page title) ---
  unsubscribe: {
    groups: publicMessageGroups("unsubscribe", "validation"),
    loader: routeTableLoader(() => import("#routes/public/unsubscribe.ts"), {
      "GET /unsubscribe": "handleUnsubscribeGet",
      "POST /unsubscribe": "handleUnsubscribePost",
    }),
    settings: [CONFIG_KEYS.WEBSITE_TITLE],
  },
  v1: {
    groups: ["tickets"],
    loader: handlerLoader(
      () => import("#routes/wallet/webservice.ts"),
      "routeWalletWebservice",
    ),
    settings: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  wallet: {
    groups: publicMessageGroups("tickets"),
    loader: handlerLoader(
      () => import("#routes/wallet/index.ts"),
      "routeWallet",
    ),
    settings: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
} satisfies Record<string, PrefixSpec>;

/** Extract the first path segment for O(1) prefix dispatch. */
export const getPrefix = (path: string): string => {
  const i = path.indexOf("/", 1);
  return i === -1 ? path.slice(1) : path.slice(1, i);
};
