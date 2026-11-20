/**
 * The alphabetical second half of the app prefix registry: `listings` through
 * `wallet`. See `prefixes.ts` for what a declaration means, and join a new
 * prefix to the half its name sorts into.
 */

import { CONFIG_KEYS } from "#db/settings.ts";
import { publicMessageGroups } from "#locales/groups.ts";
import type { PrefixSpec } from "./prefix-fold.ts";
import {
  getPostRoute,
  orderJsPrefixHandler,
  publicPageRoute,
  publicSiteGetRoute,
  readOnlyInfoHandler,
  routeFromModule,
  ticketRoutes,
} from "./prefix-handlers.ts";
import {
  APPLE_WALLET_SETTINGS,
  BOOKING_FLOW_SETTINGS,
  EMAIL_SETTINGS,
  EMBEDDABLE_BOOKING_SETTINGS,
  GOOGLE_WALLET_SETTINGS,
  PAYMENT_SETTINGS,
  PUBLIC_NAV_SETTINGS,
} from "./prefix-setting-keys.ts";

export const PREFIXES_M_Z = {
  listings: {
    ...publicPageRoute("listings", (pages) => pages.handlePublicListings),
    messageGroups: publicMessageGroups(
      "attributes",
      "availability",
      "public-site",
      "tickets",
    ),
    settings: [
      ...PUBLIC_NAV_SETTINGS,
      CONFIG_KEYS.COUNTRY,
      CONFIG_KEYS.CATALOG_GALLERY_ENABLED,
    ],
  },
  // Public news list + post pages. The full public nav renders, and the
  // published-date display reads the country for its timezone.
  news: {
    ...publicSiteGetRoute(
      routeFromModule(() => import("#routes/public/news.ts"), "routeNews"),
    ),
    messageGroups: publicMessageGroups("news", "public-site"),
    settings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  order: {
    getOnly: true,
    handler: routeFromModule(
      () => import("#routes/public/order.ts"),
      "routeOrder",
    ),
    messageGroups: publicMessageGroups(
      "availability",
      "capacity",
      "date-picker",
      "modifiers",
      "order",
      "public-site",
      "tickets",
      "validation",
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
    getOnly: true,
    handler: orderJsPrefixHandler,
    settings: [
      CONFIG_KEYS.EXTERNAL_ORDER_ENABLED,
      CONFIG_KEYS.EMBED_HOSTS,
      CONFIG_KEYS.COUNTRY,
    ],
  },
  // User-created content pages. The full public nav renders, and its
  // group-liveness check reaches the timezone-aware calendar reads, so the
  // country key rides along.
  page: {
    ...publicSiteGetRoute(
      routeFromModule(
        () => import("#routes/public/site-page.ts"),
        "routeSitePage",
      ),
    ),
    messageGroups: publicMessageGroups("public-site", "site-pages"),
    settings: [...PUBLIC_NAV_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  // Checkout and payment (bare layout, no public nav).
  pay: {
    handler: routeFromModule(
      () => import("#routes/public/balance.ts"),
      "routeBalance",
    ),
    messageGroups: publicMessageGroups(
      "ledger",
      "payment",
      "tickets",
      "validation",
    ),
    settings: PAYMENT_SETTINGS,
  },
  payment: {
    handler: routeFromModule(
      () => import("#routes/api/webhooks.ts"),
      "routePayment",
    ),
    messageGroups: ["payment", "validation"],
    settings: [...PAYMENT_SETTINGS, ...EMAIL_SETTINGS],
  },
  "read-only": {
    getOnly: true,
    handler: readOnlyInfoHandler,
    settings: [],
  },
  // Renewal renders the same booking form, whose contact-field builder checks
  // the address-lookup provider.
  renew: {
    handler: getPostRoute(
      () => import("#routes/public/renewal.ts"),
      "handleRenewalGet",
      "handleRenewalPost",
      "renew",
    ),
    messageGroups: publicMessageGroups(
      "address-lookup",
      "payment",
      "public-site",
      "renewal",
      "tickets",
      "validation",
    ),
    settings: [...BOOKING_FLOW_SETTINGS, CONFIG_KEYS.ADDRESS_LOOKUP_PROVIDER],
  },
  // The setup router owns these paths before app routing. The entry declares
  // the bundle only, so the settings read stays infra-only.
  setup: {
    settings: [],
  },
  // Inbound SMS webhook (JSON only).
  sms: {
    handler: routeFromModule(
      () => import("#routes/api/sms-webhook.ts"),
      "routeSmsWebhook",
    ),
    settings: [
      CONFIG_KEYS.SMS_GATEWAY_WEBHOOK_SECRET,
      CONFIG_KEYS.SMS_GATEWAY_PASSPHRASE,
    ],
  },
  // Ticket view and wallet passes.
  t: {
    getOnly: true,
    handler: routeFromModule(
      () => import("#routes/tickets/index.ts"),
      "routeTicketView",
    ),
    messageGroups: publicMessageGroups("listing-qr", "payment", "tickets"),
    settings: [
      CONFIG_KEYS.COUNTRY,
      ...APPLE_WALLET_SETTINGS,
      ...GOOGLE_WALLET_SETTINGS,
    ],
  },
  terms: {
    ...publicPageRoute("terms", (pages) => pages.handlePublicTerms),
    messageGroups: publicMessageGroups("public-site"),
    settings: PUBLIC_NAV_SETTINGS,
  },
  // Booking flows (form + checkout + emails). Ticket pages are embeddable, so
  // applySecurityHeaders reads embed_hosts. The form render checks the
  // address-lookup provider to decide whether the address field gets a
  // postcode search box.
  ticket: {
    handler: ticketRoutes,
    messageGroups: publicMessageGroups(
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
    settings: EMBEDDABLE_BOOKING_SETTINGS,
  },
  // Unsubscribe page (bare layout + page title).
  unsubscribe: {
    handler: getPostRoute(
      () => import("#routes/public/unsubscribe.ts"),
      "handleUnsubscribeGet",
      "handleUnsubscribePost",
      "unsubscribe",
    ),
    messageGroups: publicMessageGroups("unsubscribe", "validation"),
    settings: [CONFIG_KEYS.WEBSITE_TITLE],
  },
  v1: {
    handler: routeFromModule(
      () => import("#routes/wallet/webservice.ts"),
      "routeWalletWebservice",
    ),
    messageGroups: ["tickets"],
    settings: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
  wallet: {
    getOnly: true,
    handler: routeFromModule(
      () => import("#routes/wallet/index.ts"),
      "routeWallet",
    ),
    messageGroups: publicMessageGroups("tickets"),
    settings: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  },
} satisfies Record<string, PrefixSpec>;
