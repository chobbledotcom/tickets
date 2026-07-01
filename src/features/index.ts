/**
 * Routes module - main exports and router
 * Uses lazy loading to minimize startup time for edge scripts
 */

import { once, reduce } from "#fp";
import { parseAcceptLanguage, runWithLocale } from "#i18n";
import { SessionKeyError } from "#routes/auth.ts";
import {
  applySecurityHeaders,
  contentTypeRejectionResponse,
  getCleanUrl,
  isEmbeddablePath,
  isValidContentType,
} from "#routes/middleware.ts";
import { bufferRequestBody } from "#routes/request-body.ts";
import {
  databaseBusyResponse,
  htmlResponse,
  jsonResponse,
  migrationInProgressResponse,
  notFoundResponse,
  redirectResponse,
  siteNotActivatedResponse,
  temporaryErrorResponse,
  withCookie,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import { getClientIp, parseCookies, parseRequest } from "#routes/url.ts";
import { runWithClientIp } from "#shared/client-context.ts";
import {
  loadEffectiveDomain,
  seedEffectiveDomainHost,
} from "#shared/config.ts";
import {
  clearFlashCookie,
  clearSessionCookie,
  parseFlashValue,
} from "#shared/cookies.ts";
import { runWithCsrfContext } from "#shared/csrf.ts";
import { maybeBackfillActivityLog } from "#shared/db/activity-log-backfill.ts";
import { DatabaseBusyError } from "#shared/db/client.ts";
import {
  initDb,
  MigrationInProgressError,
  MissingSettingsTableError,
} from "#shared/db/migrations.ts";
import { maybeRunPrunes } from "#shared/db/prune.ts";
import {
  enableQueryLog,
  runWithQueryLogContext,
} from "#shared/db/query-log.ts";
import {
  CONFIG_KEYS,
  EMAIL_BODY_KEYS,
  PRUNE_KEYS,
  SNAPSHOT_KEYS,
  settings,
} from "#shared/db/settings.ts";
import {
  assertSettingsReadsDeclared,
  runWithSettingsAudit,
} from "#shared/db/settings-audit.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  hasFlash,
  runWithFlashContext,
  setFlashContext,
} from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import { takeForm } from "#shared/form-stash.ts";
import {
  clearSavedFormData,
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms.tsx";
import { detectIframeMode, runWithIframeContext } from "#shared/iframe.ts";
import {
  createRequestTimer,
  ErrorCode,
  formatRequestError,
  logError,
  logRequest,
  runWithRequestId,
} from "#shared/logger.ts";
import { addPendingWork, flushPendingWork } from "#shared/pending-work.ts";
import { runWithRequestCache } from "#shared/request-cache.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { getRethrowErrors } from "#shared/test-overrides.ts";
import { readOnlyPage } from "#templates/public.tsx";

/** Router function type - reuse from router.ts */
type RouterFn = ReturnType<typeof createRouter>;

/**
 * Lazily import a module once and pick a single export from it.
 * Import specifiers must stay literal so esbuild can bundle them.
 */
const lazyExport = <M, K extends keyof M>(
  load: () => Promise<M>,
  key: K,
): (() => Promise<M[K]>) => once(async () => (await load())[key]);

// Lazy-load route groups so the edge script only pays for what a request uses
const loadAdminRoutes = lazyExport(
  () => import("#routes/admin/index.ts"),
  "routeAdmin",
);
const loadPublicPages = once(() => import("#routes/public/pages.ts"));
const loadTicketRoutes = lazyExport(
  () => import("#routes/public/ticket-routes.ts"),
  "routeTicket",
);
const loadOrderRoutes = lazyExport(
  () => import("#routes/public/order.ts"),
  "routeOrder",
);
const loadOrderJs = lazyExport(
  () => import("#routes/public/order-js.ts"),
  "handleOrderJs",
);
const loadCustomCss = lazyExport(
  () => import("#routes/public/custom-css.ts"),
  "handleCustomCss",
);
const loadPaymentRoutes = lazyExport(
  () => import("#routes/api/webhooks.ts"),
  "routePayment",
);
const loadJoinRoutes = lazyExport(() => import("#routes/join.ts"), "routeJoin");
const loadBalanceRoutes = lazyExport(
  () => import("#routes/public/balance.ts"),
  "routeBalance",
);
const loadTicketViewRoutes = lazyExport(
  () => import("#routes/tickets/index.ts"),
  "routeTicketView",
);
const loadCheckinRoutes = lazyExport(
  () => import("#routes/checkin.ts"),
  "routeCheckin",
);
const loadImageRoutes = lazyExport(
  () => import("#routes/images.ts"),
  "routeImage",
);
const loadFeedRoutes = lazyExport(
  () => import("#routes/feeds.ts"),
  "routeFeed",
);
const loadDemoResetRoutes = lazyExport(
  () => import("#routes/admin/database-reset.ts"),
  "routeDatabaseReset",
);
const loadWalletRoutes = lazyExport(
  () => import("#routes/wallet/index.ts"),
  "routeWallet",
);
const loadGoogleWalletRoutes = lazyExport(
  () => import("#routes/wallet/google.ts"),
  "routeGoogleWallet",
);
const loadWalletWebserviceRoutes = lazyExport(
  () => import("#routes/wallet/webservice.ts"),
  "routeWalletWebservice",
);
const loadApiRoutes = lazyExport(
  () => import("#routes/api/index.ts"),
  "routeApi",
);
const loadSmsWebhookRoutes = lazyExport(
  () => import("#routes/api/sms-webhook.ts"),
  "routeSmsWebhook",
);

/** Lazy-load setup routes (bound to the setup-complete check) */
const loadSetupRoutes = once(async () =>
  (await import("#routes/setup.ts")).createSetupRouter(
    settings.setup.isComplete,
  ),
);

/** Lazy-load attachment download routes */
const loadAttachmentRoutes = once(async () =>
  createRouter((await import("#routes/attachments.ts")).attachmentRoutes),
);

/** Lazy-load admin API routes */
const loadAdminApiRoutes = once(async () =>
  createRouter((await import("#routes/admin/api.ts")).adminApiRoutes),
);

/** Lazy-load the scheduled-tasks (cron) endpoint */
const loadScheduledRoutes = once(async () =>
  createRouter((await import("#routes/scheduled.ts")).scheduledRoutes),
);

/** Lazy-load the inter-instance machine endpoint (builder only) */
const loadInstanceRoutes = once(async () =>
  createRouter((await import("#routes/instance.ts")).instanceRoutes),
);

/** Lazy-load unsubscribe routes */
const loadUnsubscribeRoutes = once(async () => {
  const { handleUnsubscribeGet, handleUnsubscribePost } = await import(
    "#routes/public/unsubscribe.ts"
  );
  return createRouter(
    defineRoutes({
      "GET /unsubscribe": handleUnsubscribeGet,
      "POST /unsubscribe": handleUnsubscribePost,
    }),
  );
});

/** Lazy-load renewal routes */
const loadRenewalRoutes = once(async () => {
  const { handleRenewalGet, handleRenewalPost } = await import(
    "#routes/public/renewal.ts"
  );
  return createRouter(
    defineRoutes({
      "GET /renew": handleRenewalGet,
      "POST /renew": handleRenewalPost,
    }),
  );
});

export type { PaymentCspConfig } from "#routes/middleware.ts";
// Re-export middleware functions for testing
export {
  buildCspHeader,
  getCleanUrl,
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
} from "#routes/middleware.ts";

// Re-export types
export type { ServerContext } from "#routes/types.ts";

/** Extract first path segment for O(1) prefix dispatch */
const getPrefix = (path: string): string => {
  const i = path.indexOf("/", 1);
  return i === -1 ? path.slice(1) : path.slice(1, i);
};

// ---------------------------------------------------------------------------
// Per-request settings pre-load (see settings-plan.md §4)
//
// The pre-routing pipeline reads settings before the lazy router resolves a
// handler, so the load is keyed off the path *prefix* (pure, import-free).
// `settingsForPath` always unions the prefix bundle with INFRA_SETTINGS, so the
// per-prefix bundles below list only the *extra* keys a route reads beyond
// infra. The whole set is fetched in one `WHERE key IN (...)` query.
// ---------------------------------------------------------------------------

/**
 * Keys every request needs regardless of route:
 * - domain resolution (`loadEffectiveDomain`) reads custom_domain + bunny_subdomain
 * - routing gates on setup_complete / show_public_*
 * - the bare `Layout` (rendered by the universal `notFoundResponse` fallback
 *   and every HTML error page) reads theme + underline_links + header_image_url
 * - `applySecurityHeaders` rebuilds the CSP on every routed response, reading
 *   the payment provider (and square_sandbox when the provider is Square)
 * - pruning self-guards on last_pruned_*
 * - the activity-log backfill self-guards on its done flag + last-run stamp
 * - session auth + PII decryption read the key material
 * - listing reads resolve listing defaults at the cache layer
 *   (`resolveListingDefaults`), which can run on any route that loads a listing;
 *   that resolution also reads has_logistics to gate the logistics default
 */
const INFRA_SETTINGS: readonly string[] = [
  CONFIG_KEYS.LISTING_DEFAULTS,
  CONFIG_KEYS.HAS_LOGISTICS,
  CONFIG_KEYS.CUSTOM_DOMAIN,
  CONFIG_KEYS.CUSTOM_DOMAIN_LAST_VALIDATED,
  CONFIG_KEYS.BUNNY_SUBDOMAIN,
  CONFIG_KEYS.SETUP_COMPLETE,
  CONFIG_KEYS.SHOW_PUBLIC_SITE,
  CONFIG_KEYS.SHOW_PUBLIC_API,
  CONFIG_KEYS.THEME,
  CONFIG_KEYS.UNDERLINE_LINKS,
  CONFIG_KEYS.HEADER_IMAGE_URL,
  CONFIG_KEYS.PAYMENT_PROVIDER,
  CONFIG_KEYS.SQUARE_SANDBOX,
  CONFIG_KEYS.LAST_PRUNED_PAYMENTS,
  CONFIG_KEYS.LAST_PRUNED_SESSIONS,
  CONFIG_KEYS.LAST_PRUNED_SUMUP,
  // The orphaned-attendee auto-purge runs from the same fire-and-forget
  // scheduler, so its enable flag, retention age, and last-run stamp must be
  // readable on every request.
  ...PRUNE_KEYS,
  CONFIG_KEYS.AUTO_PURGE_ORPHANS,
  CONFIG_KEYS.ORPHAN_PURGE_RETENTION,
  // The activity-log backfill runs from the same fire-and-forget scheduler and
  // self-guards on these every request until it has converted every legacy row.
  CONFIG_KEYS.ACTIVITY_LOG_BACKFILL_DONE,
  CONFIG_KEYS.LAST_ACTIVITY_LOG_BACKFILL,
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

/**
 * The active payment provider is resolved at runtime (`getActivePaymentProvider`),
 * so any checkout flow must be able to read all three providers' keys plus
 * country (currency) and the booking fee.
 */
const PAYMENT_SETTINGS: readonly string[] = [
  CONFIG_KEYS.PAYMENT_PROVIDER,
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
  // --- Everything (may touch any setting) ---
  admin: ADMIN_SETTINGS,
  api: ALL_SNAPSHOT_SETTINGS,
  attachment: [],
  // Booking running total: reprices the cart with the same code path as
  // /ticket, so it needs the same booking-flow settings (not the full snapshot).
  calculate: [...BOOKING_FLOW_SETTINGS, CONFIG_KEYS.EMBED_HOSTS],
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
  // --- Checkout / payment (bare layout, no public nav) ---
  pay: PAYMENT_SETTINGS,
  payment: [...PAYMENT_SETTINGS, ...EMAIL_SETTINGS],
  "read-only": [],
  renew: BOOKING_FLOW_SETTINGS,
  // Cron prune trigger: maybeRunPrunes only reads the last_pruned_*/orphan
  // settings, which are all in INFRA, so infra alone is enough.
  scheduled: [],
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
  ticket: [...BOOKING_FLOW_SETTINGS, CONFIG_KEYS.EMBED_HOSTS],
  // --- Unsubscribe page (bare layout + page title) ---
  unsubscribe: [CONFIG_KEYS.WEBSITE_TITLE],
  v1: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
  wallet: [...APPLE_WALLET_SETTINGS, CONFIG_KEYS.COUNTRY],
};

/** Settings to pre-load for a path: infra ∪ the prefix's bundle. */
const settingsForPath = (path: string): readonly string[] => {
  const prefix = getPrefix(path);
  const bundle = PREFIX_SETTINGS[prefix] ?? ALL_SNAPSHOT_SETTINGS;
  return [...INFRA_SETTINGS, ...bundle];
};

/** Create a lazy-loaded route handler (prefix already matched by dispatch map) */
const lazyRoute =
  (load: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) =>
    (await load())(request, path, method, server);

/** Read-only mode message */
const READ_ONLY_MESSAGE = "This site is in read-only mode";

/** Paths that should redirect to /read-only when visited via GET in read-only mode */
const READ_ONLY_GET_PATTERNS = [
  /^\/admin\/listing\/new$/,
  /^\/admin\/listing\/\d+\/edit$/,
  /^\/admin\/listing\/\d+\/duplicate$/,
  /^\/admin\/groups\/new$/,
  /^\/admin\/groups\/\d+\/edit$/,
  /^\/admin\/attendees\/new$/,
  /^\/admin\/ledger\/[^/]+\/[^/]+\/add$/,
  /^\/admin\/ledger\/entries\/\d+\/edit$/,
];

const isMutatingMethod = (method: string): boolean =>
  method === "DELETE" ||
  method === "PATCH" ||
  method === "POST" ||
  method === "PUT";

/**
 * Paths that remain writable in read-only mode (default-deny allowlist).
 * Any POST/PUT/PATCH/DELETE not matching one of these patterns is blocked.
 *
 * Categories:
 *  - Auth: login / logout
 *  - Billing lifecycle: renewal, balance payment, payment webhook
 *  - Apple Wallet protocol stubs (/v1/*) — must return 200/201, not redirect
 *  - Inbound webhooks: SMS
 *  - Public / owner messaging: join, unsubscribe, contact, admin support
 *  - Inter-instance machine endpoint: site credentials
 *  - Scheduled maintenance cron (builder fleet pruning)
 *  - Admin maintenance: backup creation (read-only DB dump)
 *  - On-site ops: check-in (token and admin), scan, refresh-payment, deliveries
 */
const READ_ONLY_SAFE_PATHS = [
  /^\/admin\/login$/,
  /^\/admin\/logout$/,
  /^\/renew$/,
  /^\/pay\/[^/]+$/,
  /^\/payment\/webhook$/,
  /^\/v1\/devices\/[^/]+\/registrations\/[^/]+\/[^/]+$/,
  /^\/v1\/log$/,
  /^\/sms\/webhook$/,
  /^\/join\/[^/]+$/,
  /^\/unsubscribe$/,
  /^\/contact$/,
  /^\/admin\/support$/,
  /^\/instance\/site-credentials$/,
  /^\/scheduled$/,
  /^\/admin\/backup\/create$/,
  /^\/checkin\/[^/]+$/,
  /^\/admin\/listing\/\d+\/attendee\/\d+\/checkin$/,
  /^\/admin\/listing\/\d+\/scan$/,
  /^\/admin\/attendees\/\d+\/refresh-payment$/,
  /^\/admin\/deliveries\/mark$/,
];

/**
 * Guard that blocks mutating requests in read-only mode.
 * Returns a response to send, or null to allow the request through.
 */
const readOnlyGuard = (path: string, method: string): Response | null => {
  if (!isReadOnly()) return null;

  // Block all JSON API mutations (POST/PUT/PATCH/DELETE on /api/*)
  if (path.startsWith("/api/") && isMutatingMethod(method)) {
    return jsonResponse({ error: READ_ONLY_MESSAGE }, 403);
  }

  // Block GET pages for create/edit forms (cosmetic blocklist)
  if (method === "GET") {
    for (const pattern of READ_ONLY_GET_PATTERNS) {
      if (pattern.test(path)) return redirectResponse("/read-only");
    }
  }

  // Default-deny: block all mutating requests not on the safe list
  if (isMutatingMethod(method)) {
    if (READ_ONLY_SAFE_PATHS.some((p) => p.test(path))) return null;
    return redirectResponse("/read-only");
  }

  return null;
};

type PublicPagesModule = Awaited<ReturnType<typeof loadPublicPages>>;

/** Exact path for a single-segment public page (must stay aligned with getPrefix) */
const publicPagePath = (prefix: string): string =>
  prefix === "" ? "/" : `/${prefix}`;

type PublicGetPageSpec = {
  prefix: string;
  pick: (
    pages: PublicPagesModule,
  ) => (request: Request) => Response | Promise<Response>;
};

const PUBLIC_GET_PAGES: PublicGetPageSpec[] = [
  { pick: (p) => p.handleHome, prefix: "" },
  { pick: (p) => p.handlePublicListings, prefix: "listings" },
  { pick: (p) => p.handlePublicTerms, prefix: "terms" },
];

/** Contact page handles both GET (page + form) and POST (form submission),
 * so it needs the request object — unlike the other read-only public pages. */
const contactPrefixHandler: RouterFn = async (request, reqPath, method) => {
  if (reqPath !== "/contact") return null;
  const pages = await loadPublicPages();
  if (method === "GET") return pages.handlePublicContact(request);
  if (method === "POST") return pages.handlePublicContactSubmit(request);
  return null;
};

/** Legacy redirect: the public listings page used to live at /events. */
const legacyEventsRedirectHandler: RouterFn = async (
  _request,
  reqPath,
  method,
) => {
  if (reqPath !== "/events" || method !== "GET" || !settings.showPublicSite) {
    return null;
  }
  return redirectResponse("/listings");
};

const publicPageHandlers = reduce(
  (acc: Record<string, RouterFn>, spec: PublicGetPageSpec) => {
    const { prefix, pick } = spec;
    const path = publicPagePath(prefix);
    acc[prefix] = async (request, reqPath, method) => {
      if (reqPath !== path || method !== "GET") return null;
      return pick(await loadPublicPages())(request);
    };
    return acc;
  },
  {},
)(PUBLIC_GET_PAGES);

/** Serve the dynamic `/order.js` external-order module; ignore any other path
 * under the `order.js` prefix. Named (not an inline arrow) so coverage
 * attributes its branches correctly. */
const orderJsPrefixHandler: RouterFn = async (request, path, method) => {
  if (path !== "/order.js" || method !== "GET") return null;
  const handle = await loadOrderJs();
  return handle(request);
};

/** Serve the dynamic `/custom.css` stylesheet from the `custom_css` setting;
 * ignore any other path under the `custom.css` prefix. */
const customCssPrefixHandler: RouterFn = async (_request, path, method) => {
  if (path !== "/custom.css" || method !== "GET") return null;
  const handle = await loadCustomCss();
  return handle();
};

/** Prefix dispatch table — O(1) lookup replaces the sequential ?? chain */
const prefixHandlers: Record<string, RouterFn> = {
  ...publicPageHandlers,
  // Prefix-matched lazy-loaded route groups
  admin: lazyRoute(loadAdminRoutes),
  api: async (request, path, method, server) => {
    // Admin API is always available (auth-protected)
    const adminResult = await (await loadAdminApiRoutes())(
      request,
      path,
      method,
      server,
    );
    if (adminResult) return adminResult;
    // Public API requires feature flag
    return settings.showPublicApi
      ? (await loadApiRoutes())(request, path, method, server)
      : null;
  },
  attachment: lazyRoute(loadAttachmentRoutes),
  calculate: lazyRoute(loadTicketRoutes),
  caldav: lazyRoute(loadFeedRoutes),
  checkin: lazyRoute(loadCheckinRoutes),
  contact: contactPrefixHandler,
  "custom.css": customCssPrefixHandler,
  demo: lazyRoute(loadDemoResetRoutes),
  events: legacyEventsRedirectHandler,
  feeds: lazyRoute(loadFeedRoutes),
  gwallet: lazyRoute(loadGoogleWalletRoutes),
  image: lazyRoute(loadImageRoutes),
  instance: lazyRoute(loadInstanceRoutes),
  join: lazyRoute(loadJoinRoutes),
  order: lazyRoute(loadOrderRoutes),
  "order.js": orderJsPrefixHandler,
  pay: lazyRoute(loadBalanceRoutes),
  payment: lazyRoute(loadPaymentRoutes),
  "read-only": (_request, path, method) =>
    path === "/read-only" && method === "GET"
      ? Promise.resolve(htmlResponse(readOnlyPage()))
      : Promise.resolve(null),
  renew: lazyRoute(loadRenewalRoutes),
  scheduled: lazyRoute(loadScheduledRoutes),
  sms: lazyRoute(loadSmsWebhookRoutes),
  t: lazyRoute(loadTicketViewRoutes),
  ticket: lazyRoute(loadTicketRoutes),
  unsubscribe: lazyRoute(loadUnsubscribeRoutes),
  v1: lazyRoute(loadWalletWebserviceRoutes),
  wallet: lazyRoute(loadWalletRoutes),
};

/**
 * Route main application requests (after setup is complete)
 * Uses prefix dispatch for O(1) route group lookup instead of sequential matching
 */
const routeMainApp: RouterFn = async (request, path, method, server) => {
  const blocked = readOnlyGuard(path, method);
  if (blocked) return blocked;

  const prefix = getPrefix(path);
  if (!Object.hasOwn(prefixHandlers, prefix)) return notFoundResponse();
  return (
    (await prefixHandlers[prefix]?.(request, path, method, server)) ??
    notFoundResponse()
  );
};

/**
 * Handle incoming requests (internal, without security headers)
 * Uses path-based lazy loading to minimize cold start time
 */
const handleRequestInternal = async (
  request: Request,
  path: string,
  method: string,
  server?: ServerContext,
): Promise<Response> => {
  // Setup routes - only load for /setup paths
  if (isSetupPath(path)) {
    const routeSetup = await loadSetupRoutes();
    const setupResponse = await routeSetup(request, path, method);
    if (setupResponse) return setupResponse;
  }

  // Require setup before accessing other routes
  if (!(await settings.setup.isComplete())) {
    return isSetupPath(path)
      ? redirectResponse("/setup")
      : siteNotActivatedResponse();
  }

  return (await routeMainApp(request, path, method, server))!;
};

const isSetupPath = (path: string): boolean =>
  path === "/setup" || path.startsWith("/setup/");

/**
 * Run per-request DB init. Returns the "not activated" page when the
 * database has never been set up (missing or uninitialized settings table);
 * setup paths instead bootstrap the schema via allowMissingSettings.
 */
const initializeDatabaseForPath = async (
  path: string,
): Promise<Response | null> => {
  try {
    await initDb({ allowMissingSettings: isSetupPath(path) });
    return null;
  } catch (error) {
    if (error instanceof MissingSettingsTableError) {
      return siteNotActivatedResponse();
    }
    if (error instanceof MigrationInProgressError) {
      return migrationInProgressResponse();
    }
    throw error;
  }
};

/** Log request and return response */
const logAndReturn = (
  response: Response,
  method: string,
  path: string,
  getElapsed: () => number,
): Response => {
  logRequest({
    durationMs: getElapsed(),
    method,
    path,
    status: response.status,
  });
  return response;
};

/**
 * The POST content types whose bodies a handler actually reads, and which must
 * therefore be buffered before the GC-prone awaits below. Mirrors the bodies
 * `isValidContentType` accepts: forms (urlencoded/multipart) and JSON (webhooks
 * + JSON API). A bodyless POST — `/scheduled`, `/instance/site-credentials`,
 * sent with no content-type — matches none of these and is left unbuffered, so
 * we never read a body the handler ignores.
 */
const BUFFERED_POST_CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "application/json",
] as const;

/**
 * Buffer a body-bearing POST body BEFORE the per-request DB init / settings
 * load. The Bunny Edge runtime can garbage-collect the underlying request body
 * resource during those awaits, so a handler that reads the body later — a form
 * parse, a webhook payload, a JSON API call — would otherwise throw "Cannot read
 * body as underlying resource unavailable" (logged as a generic CDN_REQUEST
 * error). Capturing it while the resource is still alive closes that window for
 * the booking/quote posts (`/calculate`, `/ticket`), webhooks, JSON API calls
 * and multipart uploads alike. Gated on content type so bodyless POSTs and
 * non-POST methods (GET/HEAD, the CalDAV verbs) pass straight through without an
 * unnecessary read. The caller runs this inside the routed `try`, so a failed
 * read is classified by `handleRoutingError` like any other.
 */
const bufferRequestIfNeeded = async (request: Request): Promise<Request> => {
  if (request.method !== "POST") return request;
  // Content-Type is case-insensitive (HTTP). Lowercase before matching so the
  // buffer gate accepts the same casings `isValidContentType` does — otherwise a
  // standards-compliant `Application/JSON` would be validated but skip buffering,
  // reopening the GC window for that casing.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const needsBuffer = BUFFERED_POST_CONTENT_TYPES.some((type) =>
    contentType.startsWith(type),
  );
  return needsBuffer ? bufferRequestBody(request) : request;
};

/**
 * If the GET URL contains tracking parameters (fbclid, utm_*, etc.), return a
 * 301 redirect to a clean URL so the CDN can cache it.
 */
const trackingParamRedirect = (url: URL, method: string): Response | null => {
  if (method !== "GET") return null;
  const cleanUrl = getCleanUrl(url);
  if (!cleanUrl) return null;
  return new Response(null, {
    headers: { location: cleanUrl },
    status: 301,
  });
};

/**
 * Populate flash context from keyed cookie (flash ID in URL).
 * Returns flashId when a flash was set so the caller can clear the cookie later.
 */
const applyFlashFromCookie = (request: Request): string | null => {
  const flashId = new URL(request.url).searchParams.get("flash");
  const flashRaw = flashId
    ? parseCookies(request).get(`flash_${flashId}`)
    : null;
  const flash = flashRaw ? parseFlashValue(flashRaw) : null;
  if (flash) setFlashContext(flash);
  // Redeem the form re-fill stash (warm-isolate optimisation). A miss is fine:
  // the flash message above still renders, matching the cookie-only fallback.
  if (flash?.formToken) {
    const stashed = takeForm(flash.formToken);
    if (stashed) setSavedFormData(new FormParams(stashed));
  }
  return flash ? flashId : null;
};

/**
 * Run settings load, schedule pruning, resolve effective domain.
 * These are per-request setup tasks that must happen before routing.
 */
const prepareRequestEnvironment = async (
  request: Request,
  path: string,
  method: string,
): Promise<void> => {
  // Turn on query recording before the settings load for admin GETs, so that
  // load appears in the debug footer. The footer itself stays staff-gated
  // (enableFooterDebug, after auth). Non-admin requests skip the overhead.
  if (method === "GET" && getPrefix(path) === "admin") enableQueryLog();

  // Kick off the settings-version probe immediately so the tiny query overlaps
  // the rest of request setup; loadKeys below awaits its result.
  settings.prefetchVersion();

  // Load only the settings this route needs (infra ∪ prefix bundle) in one
  // targeted query. When the settings version is unchanged since this isolate
  // last loaded, the cached snapshot is reused with no reload or decryption.
  await settings.loadKeys(settingsForPath(path));

  // Schedule DB pruning as fire-and-forget pending work. Each prune task
  // self-guards via its last_pruned_* timestamp, so this is near-free on most
  // requests. Skipped on the one request that edits the orphan-purge settings
  // themselves: scheduling here runs before the handler can save the submitted
  // retention or auto-purge toggle, so an enqueued orphan purge could delete
  // records with the pre-change settings (or run despite auto-purge being
  // switched off). The next request reschedules with the saved settings.
  if (!(method === "POST" && path === "/admin/privacy/orphans")) {
    addPendingWork(maybeRunPrunes());
  }

  // Drain the legacy-format activity-log backfill a batch at a time. Like the
  // prunes it self-gates on an interval and is a no-op once complete.
  addPendingWork(maybeBackfillActivityLog());

  // Load effective domain (custom_domain from DB if set, else request hostname)
  loadEffectiveDomain(request.url);
};

/** Route the request and attach security headers / flash cookie clearing */
const routeAndFinalize = async (
  request: Request,
  path: string,
  method: string,
  server: ServerContext | undefined,
): Promise<Response> => {
  const embeddable = isEmbeddablePath(path);
  const consumedFlashId = applyFlashFromCookie(request);

  const response = await handleRequestInternal(request, path, method, server);

  // Clear keyed flash cookie if one was consumed
  if (consumedFlashId && hasFlash()) {
    withCookie(response, clearFlashCookie(consumedFlashId));
  }

  return applySecurityHeaders(response, embeddable);
};

/**
 * Convert a thrown error from the routing pipeline into a response, honoring
 * the test rethrow flag and SessionKeyError special case.
 */
const handleRoutingError = (
  error: unknown,
  method: string,
  path: string,
): Response => {
  // A database too busy to acquire a write lock after retrying is a transient
  // load condition, not a bug. Log it under its own code so we can see how
  // often it happens, then show the friendly auto-reloading busy page (rather
  // than rethrowing in tests or showing the generic error page).
  if (error instanceof DatabaseBusyError) {
    logError({
      code: ErrorCode.DB_BUSY,
      detail: formatRequestError(method, path, error),
      error,
    });
    // Only auto-refresh idempotent requests: reloading a POST would drop the
    // submitted form body without replaying the write.
    return databaseBusyResponse(["GET", "HEAD"].includes(method));
  }
  logError({
    code: ErrorCode.CDN_REQUEST,
    detail: formatRequestError(method, path, error),
    error,
  });
  // In tests, surface the real error instead of swallowing it
  // behind a generic "Temporary Error" page
  if (
    getRethrowErrors() &&
    !(error instanceof SessionKeyError) &&
    !Deno.env.get("TEST_EXPECT_ERROR")
  ) {
    throw error;
  }
  if (error instanceof SessionKeyError) {
    return redirectResponse("/admin", clearSessionCookie());
  }
  return temporaryErrorResponse();
};

/**
 * The core request pipeline that runs inside all async context wrappers.
 * Performs parsing, early redirects, content-type validation, routing,
 * error handling, and logging.
 */
const processRequest = async (
  request: Request,
  server: ServerContext | undefined,
): Promise<Response> => {
  const { url, path, method } = parseRequest(request);
  const getElapsed = createRequestTimer();
  detectIframeMode(request.url);
  clearSavedFormData();

  let response!: Response;
  try {
    // Buffer the POST body up front, before the DB init / settings load awaits
    // below give the Bunny edge runtime a window to GC the body resource. Done
    // inside this try (and before the first await) so a failed read is logged
    // and rendered through handleRoutingError, not left to escape the routed
    // error path.
    const bufferedRequest = await bufferRequestIfNeeded(request);

    const staticResponse = await routeStatic(bufferedRequest, path, method);
    if (staticResponse) {
      return logAndReturn(
        await applySecurityHeaders(staticResponse, isEmbeddablePath(path)),
        method,
        path,
        getElapsed,
      );
    }

    // Seed the effective domain from the request host before touching the
    // database, so errors during migration (e.g. on the first request after a
    // cold boot) identify the real site instead of falling back to "localhost".
    // prepareRequestEnvironment() refines this once settings are loaded.
    seedEffectiveDomainHost(url.href);

    const notActivated = await initializeDatabaseForPath(path);
    if (notActivated) {
      return logAndReturn(notActivated, method, path, getElapsed);
    }

    const trackingRedirect = trackingParamRedirect(url, method);
    if (trackingRedirect) {
      return logAndReturn(trackingRedirect, method, path, getElapsed);
    }

    await prepareRequestEnvironment(bufferedRequest, path, method);

    if (!isValidContentType(bufferedRequest, path)) {
      return logAndReturn(
        contentTypeRejectionResponse(),
        method,
        path,
        getElapsed,
      );
    }

    response = logAndReturn(
      await routeAndFinalize(bufferedRequest, path, method, server),
      method,
      path,
      getElapsed,
    );
    // Dev/test safety net: prove this route declared every setting it read.
    // No-op in production (audit scope is never entered).
    assertSettingsReadsDeclared(`${method} ${path}`);
  } catch (error) {
    response = logAndReturn(
      handleRoutingError(error, method, path),
      method,
      path,
      getElapsed,
    );
  } finally {
    await flushPendingWork();
  }
  return response;
};

/**
 * Handle incoming requests with security headers and domain validation
 */
export const handleRequest = async (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  const locale = parseAcceptLanguage(request.headers.get("accept-language"));

  // Each request runs inside a stack of AsyncLocalStorage scopes so per-request
  // state (locale, client IP, caches, flash, iframe mode, CSRF token, saved
  // form data, …) stays isolated across concurrent requests sharing one edge
  // isolate. Composed as a fold rather than hand-nested callbacks so the stack
  // stays flat and adding a scope is a one-line change.
  const scopes: ((fn: () => Promise<Response>) => Promise<Response>)[] = [
    (fn) => runWithLocale(locale, fn),
    (fn) => runWithClientIp(getClientIp(request, server), fn),
    runWithRequestId,
    runWithRequestCache,
    runWithQueryLogContext,
    runWithFlashContext,
    runWithSessionContext,
    runWithIframeContext,
    runWithCsrfContext,
    runWithSavedFormContext,
    runWithSettingsAudit,
  ];

  return scopes.reduceRight<() => Promise<Response>>(
    (next, scope) => () => scope(next),
    () => processRequest(request, server),
  )();
};
