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
  isWebhookPath,
} from "#routes/middleware.ts";
import {
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
import {
  getClientIp,
  normalizePath,
  parseCookies,
  parseRequest,
} from "#routes/url.ts";
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
import {
  initDb,
  MigrationInProgressError,
  MissingSettingsTableError,
} from "#shared/db/migrations.ts";
import { maybeRunPrunes } from "#shared/db/prune.ts";
import { runWithQueryLogContext } from "#shared/db/query-log.ts";
import { settings } from "#shared/db/settings.ts";
import { isReadOnly } from "#shared/env.ts";
import {
  hasFlash,
  runWithFlashContext,
  setFlashContext,
} from "#shared/flash-context.ts";
import { FormParams } from "#shared/form-data.ts";
import { takeForm } from "#shared/form-stash.ts";
import { clearSavedFormData, setSavedFormData } from "#shared/forms.tsx";
import { detectIframeMode } from "#shared/iframe.ts";
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
];

/** Paths that should be blocked when POSTed in read-only mode */
const READ_ONLY_POST_PATTERNS = [
  /^\/ticket\//,
  /^\/admin\/listing$/,
  /^\/admin\/listing\/\d+\/edit$/,
  /^\/admin\/groups$/,
  /^\/admin\/groups\/\d+\/edit$/,
  /^\/admin\/groups\/\d+\/add-listings$/,
  /^\/admin\/listing\/\d+\/attendee$/,
  /^\/admin\/attendees\/new$/,
];

/**
 * Guard that blocks mutating requests in read-only mode.
 * Returns a response to send, or null to allow the request through.
 */
const readOnlyGuard = (path: string, method: string): Response | null => {
  if (!isReadOnly()) return null;

  // Block all JSON API mutations (POST/PUT/DELETE on /api/*)
  if (path.startsWith("/api/") && method !== "GET" && method !== "OPTIONS") {
    return jsonResponse({ error: READ_ONLY_MESSAGE }, 403);
  }

  // Block GET pages for create/edit forms
  if (method === "GET") {
    for (const pattern of READ_ONLY_GET_PATTERNS) {
      if (pattern.test(path)) return redirectResponse("/read-only");
    }
  }

  // Block form POSTs for create/edit actions
  if (method === "POST") {
    for (const pattern of READ_ONLY_POST_PATTERNS) {
      if (pattern.test(path)) return redirectResponse("/read-only");
    }
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
  checkin: lazyRoute(loadCheckinRoutes),
  contact: contactPrefixHandler,
  demo: lazyRoute(loadDemoResetRoutes),
  // Legacy redirect: the public listings page used to live at /events.
  // Only active when the public site is enabled (otherwise /listings itself
  // redirects to the admin login).
  events: (_request, reqPath, method) =>
    reqPath === "/events" && method === "GET" && settings.showPublicSite
      ? Promise.resolve(redirectResponse("/listings"))
      : Promise.resolve(null),
  feeds: lazyRoute(loadFeedRoutes),
  gwallet: lazyRoute(loadGoogleWalletRoutes),
  image: lazyRoute(loadImageRoutes),
  join: lazyRoute(loadJoinRoutes),
  order: lazyRoute(loadOrderRoutes),
  pay: lazyRoute(loadBalanceRoutes),
  payment: lazyRoute(loadPaymentRoutes),
  "read-only": (_request, path, method) =>
    path === "/read-only" && method === "GET"
      ? Promise.resolve(htmlResponse(readOnlyPage()))
      : Promise.resolve(null),
  renew: lazyRoute(loadRenewalRoutes),
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
 * Buffer POST bodies BEFORE entering async context wrappers. The Bunny Edge
 * runtime can garbage-collect the underlying request body resource during
 * awaits, so we must capture it while the resource is still alive.
 * This applies to webhook bodies (JSON) and multipart form uploads (file
 * data backed by Blob resources that are especially prone to GC).
 * Use normalizePath on the raw pathname so trailing-slash variants like
 * /payment/webhook/ are correctly detected (the router normalizes later,
 * but by then the body resource may already be garbage-collected).
 */
const bufferRequestIfNeeded = async (request: Request): Promise<Request> => {
  const { pathname } = new URL(request.url);
  const contentType = request.headers.get("content-type") ?? "";
  const needsBodyBuffer =
    request.method === "POST" &&
    (isWebhookPath(normalizePath(pathname)) ||
      contentType.startsWith("multipart/form-data"));
  if (!needsBodyBuffer) return request;
  const bufferedBody = new Uint8Array(await request.arrayBuffer());
  return new Request(request.url, {
    body: bufferedBody,
    headers: request.headers,
    method: request.method,
  });
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
const prepareRequestEnvironment = async (request: Request): Promise<void> => {
  // Ensure settings cache is populated before reading custom domain.
  // loadAll() is a no-op when the cache is still valid (60 s TTL).
  await settings.loadAll();

  // Schedule DB pruning as fire-and-forget pending work. Each
  // prune task self-guards via its last_pruned_* timestamp, so
  // this is near-free on most requests.
  addPendingWork(maybeRunPrunes());

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
  logError({
    code: ErrorCode.CDN_REQUEST,
    detail: formatRequestError(method, path, error),
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
  effectiveRequest: Request,
  server: ServerContext | undefined,
): Promise<Response> => {
  const { url, path, method } = parseRequest(effectiveRequest);
  const getElapsed = createRequestTimer();
  detectIframeMode(effectiveRequest.url);
  clearSavedFormData();

  let response!: Response;
  try {
    const staticResponse = await routeStatic(effectiveRequest, path, method);
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

    await prepareRequestEnvironment(effectiveRequest);

    if (!isValidContentType(effectiveRequest, path)) {
      return logAndReturn(
        contentTypeRejectionResponse(),
        method,
        path,
        getElapsed,
      );
    }

    response = logAndReturn(
      await routeAndFinalize(effectiveRequest, path, method, server),
      method,
      path,
      getElapsed,
    );
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
  const effectiveRequest = await bufferRequestIfNeeded(request);
  const locale = parseAcceptLanguage(
    effectiveRequest.headers.get("accept-language"),
  );

  return runWithLocale(locale, () =>
    runWithClientIp(getClientIp(request, server), () =>
      runWithRequestId(() =>
        runWithRequestCache(() =>
          runWithQueryLogContext(() =>
            runWithFlashContext(() =>
              runWithSessionContext(() =>
                processRequest(effectiveRequest, server),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};
