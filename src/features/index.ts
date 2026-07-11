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
import {
  emptyCustomCssResponse,
  isCssResponse,
} from "#routes/public/custom-css.ts";
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
import {
  createRouter,
  defineRoutes,
  type RouteHandlerFn,
} from "#routes/router.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import { getClientIp, parseCookies, parseRequest } from "#routes/url.ts";
import { readOnlyGetRoutePatterns } from "#shared/admin-pages.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
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
import { settings } from "#shared/db/settings.ts";
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
import { routePathPatternToRegex } from "#shared/route-pattern.ts";
import { runWithSessionContext } from "#shared/session-context.ts";
import { getRethrowErrors } from "#shared/test-overrides.ts";
import { readOnlyPage } from "#templates/public/errors.tsx";

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

const loadPublicPages = once(() => import("#routes/public/pages.ts"));

/** Lazy-load a small route table assembled from named handlers. */
const lazyRouter = <M>(
  load: () => Promise<M>,
  routes: (module: M) => Record<string, RouteHandlerFn>,
): (() => Promise<RouterFn>) =>
  once(async () => createRouter(routes(await load())));

// Lazy-load route groups so the edge script only pays for what a request uses.
// Import specifiers stay literal so esbuild can still bundle every target.
const routeLoaders = {
  admin: lazyExport(() => import("#routes/admin/index.ts"), "routeAdmin"),
  api: lazyExport(() => import("#routes/api/index.ts"), "routeApi"),
  balance: lazyExport(
    () => import("#routes/public/balance.ts"),
    "routeBalance",
  ),
  checkin: lazyExport(() => import("#routes/checkin.ts"), "routeCheckin"),
  demoReset: lazyExport(
    () => import("#routes/admin/database-reset.ts"),
    "routeDatabaseReset",
  ),
  feed: lazyExport(() => import("#routes/feeds.ts"), "routeFeed"),
  googleWallet: lazyExport(
    () => import("#routes/wallet/google.ts"),
    "routeGoogleWallet",
  ),
  image: lazyExport(() => import("#routes/images.ts"), "routeImage"),
  join: lazyExport(() => import("#routes/join.ts"), "routeJoin"),
  news: lazyExport(() => import("#routes/public/news.ts"), "routeNews"),
  order: lazyExport(() => import("#routes/public/order.ts"), "routeOrder"),
  payment: lazyExport(() => import("#routes/api/webhooks.ts"), "routePayment"),
  sitePage: lazyExport(
    () => import("#routes/public/site-page.ts"),
    "routeSitePage",
  ),
  smsWebhook: lazyExport(
    () => import("#routes/api/sms-webhook.ts"),
    "routeSmsWebhook",
  ),
  ticket: lazyExport(
    () => import("#routes/public/ticket-routes.ts"),
    "routeTicket",
  ),
  ticketView: lazyExport(
    () => import("#routes/tickets/index.ts"),
    "routeTicketView",
  ),
  wallet: lazyExport(() => import("#routes/wallet/index.ts"), "routeWallet"),
  walletWebservice: lazyExport(
    () => import("#routes/wallet/webservice.ts"),
    "routeWalletWebservice",
  ),
};

const handlerLoaders = {
  customCss: lazyExport(
    () => import("#routes/public/custom-css.ts"),
    "handleCustomCss",
  ),
  orderJs: lazyExport(
    () => import("#routes/public/order-js.ts"),
    "handleOrderJs",
  ),
};

/** Lazy-load setup routes (bound to the setup-complete check) */
const loadSetupRoutes = once(async () =>
  (await import("#routes/setup.ts")).createSetupRouter(
    settings.setup.isComplete,
  ),
);

const loadAttachmentRoutes = once(async () =>
  createRouter((await import("#routes/attachments.ts")).attachmentRoutes),
);

const loadAdminApiRoutes = once(async () =>
  createRouter((await import("#routes/admin/api.ts")).adminApiRoutes),
);

const loadScheduledRoutes = once(async () =>
  createRouter((await import("#routes/scheduled.ts")).scheduledRoutes),
);

const loadInstanceRoutes = once(async () =>
  createRouter((await import("#routes/instance.ts")).instanceRoutes),
);

const exactRouteLoaders = {
  addressLookup: lazyRouter(
    () => import("#routes/public/address-lookup.ts"),
    ({ handleAddressLookupGet }) =>
      defineRoutes({ "GET /address-lookup": handleAddressLookupGet }),
  ),
  renewal: lazyRouter(
    () => import("#routes/public/renewal.ts"),
    ({ handleRenewalGet, handleRenewalPost }) =>
      defineRoutes({
        "GET /renew": handleRenewalGet,
        "POST /renew": handleRenewalPost,
      }),
  ),
  unsubscribe: lazyRouter(
    () => import("#routes/public/unsubscribe.ts"),
    ({ handleUnsubscribeGet, handleUnsubscribePost }) =>
      defineRoutes({
        "GET /unsubscribe": handleUnsubscribeGet,
        "POST /unsubscribe": handleUnsubscribePost,
      }),
  ),
};

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

import { getPrefix, settingsForPath } from "#routes/settings-bundles.ts";

/** Create a lazy-loaded route handler (prefix already matched by dispatch map) */
const lazyRoute =
  (load: () => Promise<RouterFn>): RouterFn =>
  async (request, path, method, server) =>
    (await load())(request, path, method, server);

/** Read-only mode message */
const READ_ONLY_MESSAGE = "This site is in read-only mode";

/** GET routes that redirect to /read-only when visited in read-only mode —
 * the create/edit/delete/duplicate form pages. Derived from the admin-page
 * schema's create links and mutatingGetRoutes. */
const READ_ONLY_GET_PATTERNS = readOnlyGetRoutePatterns().map(
  routePathPatternToRegex,
);

const READ_ONLY_ADMIN_OPERATIONS = ADMIN_SURFACE.routes
  .filter((route) => route.method !== "GET" && route.readOnly === "allow")
  .map((route) => ({
    method: route.method,
    pattern: routePathPatternToRegex(route.pattern),
  }));

const isAdminMutation = (path: string, method: string): boolean =>
  isMutatingMethod(method) && (path === "/admin" || path.startsWith("/admin/"));

const isAllowedAdminOperation = (path: string, method: string): boolean =>
  READ_ONLY_ADMIN_OPERATIONS.some(
    (route) => route.method === method && route.pattern.test(path),
  );

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
 *  - Billing lifecycle: renewal, balance payment, payment webhook
 *  - Apple Wallet protocol stubs (/v1/*) — must return 200/201, not redirect
 *  - Inbound webhooks: SMS
 *  - Public messaging: join, unsubscribe, contact
 *  - Inter-instance machine endpoint: site credentials
 *  - Scheduled maintenance cron (builder fleet pruning)
 *  - On-site ops: token check-in
 */
const READ_ONLY_SAFE_PATHS = [
  /^\/renew$/,
  /^\/pay\/[^/]+$/,
  /^\/payment\/webhook$/,
  /^\/v1\/devices\/[^/]+\/registrations\/[^/]+\/[^/]+$/,
  /^\/v1\/log$/,
  /^\/sms\/webhook$/,
  /^\/join\/[^/]+$/,
  /^\/unsubscribe$/,
  /^\/contact$/,
  /^\/instance\/site-credentials$/,
  /^\/scheduled$/,
  /^\/checkin\/[^/]+$/,
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

  if (isAdminMutation(path, method)) {
    return isAllowedAdminOperation(path, method)
      ? null
      : redirectResponse("/read-only");
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
  const handle = await handlerLoaders.orderJs();
  return handle(request);
};

/** Serve the dynamic `/custom.css` stylesheet from the `custom_css` setting;
 * ignore any other path under the `custom.css` prefix. */
const customCssPrefixHandler: RouterFn = async (_request, path, method) => {
  if (path !== "/custom.css" || method !== "GET") return null;
  const handle = await handlerLoaders.customCss();
  return handle();
};

/** Prefix dispatch table — O(1) lookup replaces the sequential ?? chain */
const prefixHandlers: Record<string, RouterFn> = {
  ...publicPageHandlers,
  // Prefix-matched lazy-loaded route groups
  "address-lookup": lazyRoute(exactRouteLoaders.addressLookup),
  admin: lazyRoute(routeLoaders.admin),
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
      ? (await routeLoaders.api())(request, path, method, server)
      : null;
  },
  attachment: lazyRoute(loadAttachmentRoutes),
  calculate: lazyRoute(routeLoaders.ticket),
  caldav: lazyRoute(routeLoaders.feed),
  checkin: lazyRoute(routeLoaders.checkin),
  contact: contactPrefixHandler,
  "custom.css": customCssPrefixHandler,
  demo: lazyRoute(routeLoaders.demoReset),
  events: legacyEventsRedirectHandler,
  feeds: lazyRoute(routeLoaders.feed),
  gwallet: lazyRoute(routeLoaders.googleWallet),
  image: lazyRoute(routeLoaders.image),
  instance: lazyRoute(loadInstanceRoutes),
  join: lazyRoute(routeLoaders.join),
  news: lazyRoute(routeLoaders.news),
  order: lazyRoute(routeLoaders.order),
  "order.js": orderJsPrefixHandler,
  page: lazyRoute(routeLoaders.sitePage),
  pay: lazyRoute(routeLoaders.balance),
  payment: lazyRoute(routeLoaders.payment),
  "read-only": (_request, path, method) =>
    path === "/read-only" && method === "GET"
      ? Promise.resolve(htmlResponse(readOnlyPage()))
      : Promise.resolve(null),
  renew: lazyRoute(exactRouteLoaders.renewal),
  scheduled: lazyRoute(loadScheduledRoutes),
  sms: lazyRoute(routeLoaders.smsWebhook),
  t: lazyRoute(routeLoaders.ticketView),
  ticket: lazyRoute(routeLoaders.ticket),
  unsubscribe: lazyRoute(exactRouteLoaders.unsubscribe),
  v1: lazyRoute(routeLoaders.walletWebservice),
  wallet: lazyRoute(routeLoaders.wallet),
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

  // Load only the settings this route needs (infra ∪ prefix bundle) in one
  // targeted query, awaiting the version probe prefetched in processRequest.
  // When the version is unchanged since this isolate last loaded, the cached
  // snapshot is reused with no reload or decryption.
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

const CUSTOM_CSS_PATH = "/custom.css";

/** True for a 3xx redirect response (bodyless — never a stray stylesheet). */
const isRedirectResponse = (response: Response): boolean =>
  response.status >= 300 && response.status < 400;

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

  // The public layout links /custom.css on every page, including the system
  // pages the pipeline answers before the dynamic CSS route runs (setup /
  // site-not-activated, migration-in-progress, transient error). Serving those
  // HTML fallbacks for this asset trips the browser's strict MIME check, so an
  // HTML response for /custom.css is coerced to an empty stylesheet. On a
  // healthy site the route already returns text/css, making this a no-op.
  // Redirects (3xx) pass through untouched — a bodyless redirect isn't a stray
  // stylesheet, and coercing one would swallow the tracking-param cleanup that
  // rewrites e.g. /custom.css?utm_source=x to the clean URL before the CSS is
  // served.
  const finish = (response: Response): Response =>
    logAndReturn(
      path === CUSTOM_CSS_PATH &&
        !isRedirectResponse(response) &&
        !isCssResponse(response)
        ? emptyCustomCssResponse()
        : response,
      method,
      path,
      getElapsed,
    );

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
      return finish(
        await applySecurityHeaders(staticResponse, isEmbeddablePath(path)),
      );
    }

    // Seed the effective domain from the request host before touching the
    // database, so errors during migration (e.g. on the first request after a
    // cold boot) identify the real site instead of falling back to "localhost".
    // prepareRequestEnvironment() refines this once settings are loaded.
    seedEffectiveDomainHost(url.href);

    // A tracked URL is a pure redirect: answer it before the prefetch and
    // initDb so the request touches the database not at all.
    const trackingRedirect = trackingParamRedirect(url, method);
    if (trackingRedirect) {
      return finish(trackingRedirect);
    }

    // Start the settings-version probe so its round trip overlaps the schema
    // state check below. Not on setup paths: the settings table may not
    // exist until initDb bootstraps it, and the request cache would share
    // the probe's still-pending failure with the post-bootstrap loadKeys.
    if (!isSetupPath(path)) {
      settings.prefetchVersion();
    }

    const notActivated = await initializeDatabaseForPath(path);
    if (notActivated) {
      return finish(notActivated);
    }

    await prepareRequestEnvironment(bufferedRequest, path, method);

    if (!isValidContentType(bufferedRequest, path)) {
      return finish(contentTypeRejectionResponse());
    }

    response = finish(
      await routeAndFinalize(bufferedRequest, path, method, server),
    );
    // Dev/test safety net: prove this route declared every setting it read.
    // No-op in production (audit scope is never entered).
    assertSettingsReadsDeclared(`${method} ${path}`);
  } catch (error) {
    response = finish(handleRoutingError(error, method, path));
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
