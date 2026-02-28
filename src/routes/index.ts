/**
 * Routes module - main exports and router
 * Uses lazy loading to minimize startup time for edge scripts
 */

import { once } from "#fp";
import { isSetupComplete } from "#lib/config.ts";
import { loadCurrencyCode } from "#lib/currency.ts";
import { loadHeaderImage } from "#lib/header-image.ts";
import { loadTheme } from "#lib/theme.ts";
import { runWithQueryLogContext } from "#lib/db/query-log.ts";
import { createRequestTimer, ErrorCode, logDebug, logError, logRequest, runWithRequestId } from "#lib/logger.ts";
import { flushPendingWork } from "#lib/pending-work.ts";
import {
  applySecurityHeaders,
  buildDomainRedirectUrl,
  contentTypeRejectionResponse,
  domainRedirectResponse,
  getCleanUrl,
  getDomainRejectionReason,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
} from "#routes/middleware.ts";
import type { createRouter } from "#routes/router.ts";
import { routeStatic } from "#routes/static.ts";
import type { ServerContext } from "#routes/types.ts";
import { notFoundResponse, parseRequest, redirect, temporaryErrorResponse } from "#routes/utils.ts";

/** Router function type - reuse from router.ts */
type RouterFn = ReturnType<typeof createRouter>;

/** Lazy-load admin routes (only needed for authenticated admin requests) */
const loadAdminRoutes = once(async () => {
  const { routeAdmin } = await import("#routes/admin/index.ts");
  return routeAdmin;
});

/** Lazy-load public routes (ticket reservation) */
const loadPublicRoutes = once(async () => {
  const {
    handleHome,
    handlePublicEvents,
    handlePublicTerms,
    handlePublicContact,
    routeTicket,
  } = await import("#routes/public.ts");
  return { handleHome, handlePublicEvents, handlePublicTerms, handlePublicContact, routeTicket };
});

/** Lazy-load setup routes */
const loadSetupRoutes = once(async () => {
  const { createSetupRouter } = await import("#routes/setup.ts");
  return createSetupRouter(isSetupComplete);
});

/** Lazy-load payment/webhook routes */
const loadPaymentRoutes = once(async () => {
  const { routePayment } = await import("#routes/webhooks.ts");
  return routePayment;
});

/** Lazy-load join/invite routes */
const loadJoinRoutes = once(async () => {
  const { routeJoin } = await import("#routes/join.ts");
  return routeJoin;
});

/** Lazy-load ticket view routes */
const loadTicketViewRoutes = once(async () => {
  const { routeTicketView } = await import("#routes/tickets.ts");
  return routeTicketView;
});

/** Lazy-load check-in routes */
const loadCheckinRoutes = once(async () => {
  const { routeCheckin } = await import("#routes/checkin.ts");
  return routeCheckin;
});

/** Lazy-load image proxy routes */
const loadImageRoutes = once(async () => {
  const { routeImage } = await import("#routes/images.ts");
  return routeImage;
});

// Re-export middleware functions for testing
export {
  getCleanUrl,
  getSecurityHeaders,
  isEmbeddablePath,
  isValidContentType,
  isValidDomain,
  normalizeHostname,
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

/** Prefix dispatch table — O(1) lookup replaces the sequential ?? chain */
const prefixHandlers: Record<string, RouterFn> = {
  // Exact-match public pages
  "": async (_request, path, method) => {
    if (path !== "/" || method !== "GET") return null;
    const { handleHome } = await loadPublicRoutes();
    return handleHome();
  },
  events: async (_request, path, method) => {
    if (path !== "/events" || method !== "GET") return null;
    const { handlePublicEvents } = await loadPublicRoutes();
    return handlePublicEvents();
  },
  terms: async (_request, path, method) => {
    if (path !== "/terms" || method !== "GET") return null;
    const { handlePublicTerms } = await loadPublicRoutes();
    return handlePublicTerms();
  },
  contact: async (_request, path, method) => {
    if (path !== "/contact" || method !== "GET") return null;
    const { handlePublicContact } = await loadPublicRoutes();
    return handlePublicContact();
  },
  // Prefix-matched lazy-loaded route groups
  admin: lazyRoute(loadAdminRoutes),
  ticket: lazyRoute(async () => (await loadPublicRoutes()).routeTicket),
  t: lazyRoute(loadTicketViewRoutes),
  checkin: lazyRoute(loadCheckinRoutes),
  image: lazyRoute(loadImageRoutes),
  payment: lazyRoute(loadPaymentRoutes),
  join: lazyRoute(loadJoinRoutes),
};

/**
 * Route main application requests (after setup is complete)
 * Uses prefix dispatch for O(1) route group lookup instead of sequential matching
 */
const routeMainApp: RouterFn = async (request, path, method, server) => {
  const prefix = getPrefix(path);
  if (!Object.hasOwn(prefixHandlers, prefix)) return notFoundResponse();
  return (await prefixHandlers[prefix]!(request, path, method, server)) ?? notFoundResponse();
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
  // Static routes always available (minimal overhead)
  const staticResponse = await routeStatic(request, path, method);
  if (staticResponse) return staticResponse;

  // Setup routes - only load for /setup paths
  if (path === "/setup" || path.startsWith("/setup/")) {
    const routeSetup = await loadSetupRoutes();
    const setupResponse = await routeSetup(request, path, method);
    if (setupResponse) return setupResponse;
  }

  // Require setup before accessing other routes
  if (!(await isSetupComplete())) {
    return redirect("/setup");
  }

  await loadCurrencyCode();
  await loadTheme();
  await loadHeaderImage();
  return (await routeMainApp(request, path, method, server))!;
};

/** Log request and return response */
const logAndReturn = (
  response: Response,
  method: string,
  path: string,
  getElapsed: () => number,
): Response => {
  logRequest({ method, path, status: response.status, durationMs: getElapsed() });
  return response;
};

/**
 * Handle incoming requests with security headers and domain validation
 */
export const handleRequest = (
  request: Request,
  server?: ServerContext,
): Promise<Response> => {
  return runWithRequestId(() => runWithQueryLogContext(async () => {
  const { url, path, method } = parseRequest(request);
  const getElapsed = createRequestTimer();

  try {
  // Strip tracking parameters (fbclid, utm_*, etc.) to avoid CDN caching issues
  if (method === "GET") {
    const cleanUrl = getCleanUrl(url);
    if (cleanUrl) {
      return logAndReturn(
        new Response(null, { status: 301, headers: { location: cleanUrl } }),
        method, path, getElapsed,
      );
    }
  }

  // Domain validation: redirect requests from unauthorized domains to the allowed domain
  if (!isValidDomain(request)) {
    const redirectUrl = buildDomainRedirectUrl(request);
    logDebug("Domain", `Redirecting to ${redirectUrl} (${getDomainRejectionReason(request)})`);
    return logAndReturn(domainRedirectResponse(redirectUrl), method, path, getElapsed);
  }

  const embeddable = isEmbeddablePath(path);

  // Content-Type validation: reject POST requests without proper Content-Type
  // (webhook endpoints accept JSON, all others require form-urlencoded)
  if (!isValidContentType(request, path)) {
    return logAndReturn(contentTypeRejectionResponse(), method, path, getElapsed);
  }

  try {
    const response = await handleRequestInternal(request, path, method, server);
    return logAndReturn(await applySecurityHeaders(response, embeddable), method, path, getElapsed);
  } catch (error) {
    logError({ code: ErrorCode.CDN_REQUEST, detail: String(error) });
    return logAndReturn(temporaryErrorResponse(), method, path, getElapsed);
  }
  } finally {
    await flushPendingWork();
  }
  }));
};
